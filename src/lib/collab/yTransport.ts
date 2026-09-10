import * as Y from 'yjs';
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';

/**
 * A Yjs document, carried over Supabase Realtime.
 *
 * Convergence is Yjs's problem, not this file's. That is the whole reason for
 * the dependency: two people typing in the same place at the same time is a
 * distributed-systems problem with known-correct answers and a great many wrong
 * ones, and a homemade "last write wins" merge over a WebSocket is how a
 * collaborative editor silently eats somebody's afternoon. Yjs is a CRDT; this
 * module is only the wire it travels on.
 *
 * **The wire is Realtime broadcast, not a database table.** Keystroke-rate
 * updates belong on a channel, not in Postgres. The file's durable copy is
 * still the project's own storage, written by the editor exactly as it always
 * was: this transport is what the collaborators agree through, and the save
 * path underneath is unchanged.
 *
 * **Bootstrapping is the hard part, and it is explicit.** An empty document
 * that seeds itself from local file content will duplicate every line when two
 * peers seed at once — the classic Yjs bootstrap bug, and it looks exactly like
 * corruption. So a joiner asks its peers for state first and only seeds if
 * nobody answers within a bounded window. `status` says which of those
 * happened, and the editor stays read-only until the answer is known rather
 * than letting somebody type into a document that is about to be replaced.
 */

/** How long a joiner waits for a peer's state before deciding it is alone. */
const BOOTSTRAP_WAIT_MS = 1_200;

/** Largest single broadcast payload, so one edit cannot become a flood. */
const MAX_PAYLOAD_BYTES = 512 * 1024;

export type CollabStatus =
  /** No transport. The editor is a single-player editor and says so. */
  | 'offline'
  /** Joined; waiting to learn whether a peer already holds this document. */
  | 'bootstrapping'
  /** Synchronised. Edits are shared. */
  | 'connected'
  /** The channel failed. Edits are local only, and that is reported. */
  | 'error';

interface Message {
  k: 'update' | 'awareness' | 'query' | 'state';
  /** base64 of a Yjs binary payload. Absent for `query`. */
  v?: string;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
  } catch {
    // Anything that is not base64 came from a peer that is not this app.
    return null;
  }
}

export interface DocumentSessionOptions {
  client: SupabaseClient;
  projectId: string;
  path: string;
  /** This tab's identity, published through awareness for remote cursors. */
  identity: { userId: string; displayName: string; colour: string };
  /**
   * The file's current content, used only if this tab turns out to be the
   * first peer. Never applied over a document a peer already holds.
   */
  initialText: () => string;
  onStatus: (status: CollabStatus, detail?: string) => void;
}

export interface DocumentSession {
  doc: Y.Doc;
  text: Y.Text;
  awareness: Awareness;
  status: () => CollabStatus;
  destroy: () => void;
}

/**
 * A stable, collision-resistant channel name for one file.
 *
 * A path can contain anything, and a topic cannot. This is not a security
 * boundary — the topic is guessable either way — it is only about producing a
 * legal, stable name for the same file on every peer.
 */
export function channelNameFor(projectId: string, path: string): string {
  let hash = 5381;
  for (let i = 0; i < path.length; i++) hash = ((hash << 5) + hash + path.charCodeAt(i)) >>> 0;
  return `collab:${projectId}:${hash.toString(36)}:${path.length}`;
}

export function openDocumentSession(options: DocumentSessionOptions): DocumentSession {
  const doc = new Y.Doc();
  const text = doc.getText('content');
  const awareness = new Awareness(doc);
  let status: CollabStatus = 'bootstrapping';
  let bootstrapTimer: ReturnType<typeof setTimeout> | null = null;
  let destroyed = false;
  /** Set while shutting down, so the departure still reaches the room. */
  let closing = false;

  awareness.setLocalStateField('user', options.identity);

  const setStatus = (next: CollabStatus, detail?: string) => {
    if (destroyed || status === next) return;
    status = next;
    options.onStatus(next, detail);
  };

  const channel: RealtimeChannel = options.client.channel(
    channelNameFor(options.projectId, options.path),
    { config: { broadcast: { self: false } } },
  );

  const post = (message: Message) => {
    if (destroyed) return;
    if (message.v && message.v.length > MAX_PAYLOAD_BYTES) {
      // A payload this large is a document being sent whole, not an edit. It is
      // dropped rather than truncated: half a Yjs update is not a smaller
      // update, it is a corrupt one.
      setStatus('error', 'A document update was too large to share.');
      return;
    }
    void channel.send({ type: 'broadcast', event: 'y', payload: message });
  };

  /*
   * Local changes go out; remote ones do not come back.
   *
   * `origin` is the transport itself for anything applied from a peer, so this
   * handler ignores those and cannot echo an update round the room forever.
   */
  const onDocUpdate = (update: Uint8Array, origin: unknown) => {
    if (origin === channel) return;
    post({ k: 'update', v: toBase64(update) });
  };
  doc.on('update', onDocUpdate);

  const onAwarenessUpdate = (
    { added, updated, removed }: { added: number[]; updated: number[]; removed: number[] },
    origin: unknown,
  ) => {
    if (origin === channel) return;
    const changed = [...added, ...updated, ...removed];
    if (!changed.length) return;
    post({ k: 'awareness', v: toBase64(encodeAwarenessUpdate(awareness, changed)) });
  };
  awareness.on('update', onAwarenessUpdate);

  /**
   * Seed the document from local content, once, and only when alone.
   *
   * Guarded twice: by having heard no peer state, and by the document still
   * being empty. Two peers seeding the same file is what produces a document
   * containing every line twice.
   */
  const seedIfAlone = () => {
    if (destroyed) return;
    if (text.length === 0) {
      const initial = options.initialText();
      if (initial) doc.transact(() => text.insert(0, initial));
    }
    setStatus('connected');
  };

  const handle = (message: unknown) => {
    if (destroyed || !message || typeof message !== 'object') return;
    const { k, v } = message as Message;

    if (k === 'query') {
      // A joiner is asking whether anybody holds this file. Answering with the
      // whole document is what stops it seeding a duplicate.
      post({ k: 'state', v: toBase64(Y.encodeStateAsUpdate(doc)) });
      // And tell it who is here, so remote cursors appear without waiting.
      const clients = [...awareness.getStates().keys()];
      if (clients.length) post({ k: 'awareness', v: toBase64(encodeAwarenessUpdate(awareness, clients)) });
      return;
    }

    if (k === 'state' || k === 'update') {
      const bytes = v ? fromBase64(v) : null;
      if (!bytes) return;
      try {
        // `channel` as the origin marks this as remote, so it is not re-sent.
        Y.applyUpdate(doc, bytes, channel);
      } catch {
        // A malformed update from a peer must not take this tab's editor down.
        return;
      }
      if (k === 'state') {
        // Somebody already holds this file, so this tab must not seed it.
        if (bootstrapTimer) {
          clearTimeout(bootstrapTimer);
          bootstrapTimer = null;
        }
        setStatus('connected');
      }
      return;
    }

    if (k === 'awareness') {
      const bytes = v ? fromBase64(v) : null;
      if (!bytes) return;
      try {
        applyAwarenessUpdate(awareness, bytes, channel);
      } catch {
        return;
      }
    }
  };

  channel
    .on('broadcast', { event: 'y' }, (payload: { payload?: unknown }) => handle(payload.payload))
    .subscribe((state) => {
      if (destroyed) return;
      if (state === 'SUBSCRIBED') {
        post({ k: 'query' });
        /*
         * Announce this tab.
         *
         * The local awareness state is set before the channel exists, so its
         * `update` event fired with nothing listening and nowhere to send it.
         * Without this a joiner sees everyone already in the room while nobody
         * sees the joiner — their caret is invisible to the people they are
         * working with, which is the half of presence that matters.
         */
        post({ k: 'awareness', v: toBase64(encodeAwarenessUpdate(awareness, [doc.clientID])) });
        // Nobody has answered yet. If nobody does, this tab is the first peer.
        bootstrapTimer = setTimeout(seedIfAlone, BOOTSTRAP_WAIT_MS);
        return;
      }
      if (state === 'CHANNEL_ERROR' || state === 'TIMED_OUT' || state === 'CLOSED') {
        setStatus('error', 'The collaboration channel is not connected. Edits are local only.');
      }
    });

  return {
    doc,
    text,
    awareness,
    status: () => status,
    destroy() {
      if (destroyed || closing) return;
      // `closing` rather than `destroyed`, because the goodbye below still has
      // to go out and `post` refuses to send once destroyed.
      closing = true;
      if (bootstrapTimer) clearTimeout(bootstrapTimer);
      doc.off('update', onDocUpdate);
      /*
       * Say goodbye before hanging up.
       *
       * `removeAwarenessStates` announces the departure through the same
       * `update` event everything else uses, so the handler has to still be
       * attached and the channel still open when it runs. Detaching first —
       * the obvious order — sent nothing, and left this person's caret sitting
       * in everyone else's editor as somebody who is still there.
       */
      removeAwarenessStates(awareness, [doc.clientID], 'closed');
      awareness.off('update', onAwarenessUpdate);
      destroyed = true;
      void channel.unsubscribe();
      awareness.destroy();
      doc.destroy();
    },
  };
}

export const __testing = { toBase64, fromBase64, BOOTSTRAP_WAIT_MS };
