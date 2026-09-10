import type { editor } from 'monaco-editor';
import { MonacoBinding } from 'y-monaco';
import type { SupabaseClient } from '@supabase/supabase-js';
import { openDocumentSession, type CollabStatus, type DocumentSession } from '@/lib/collab/yTransport';
import { colourFor, useCollabStore, type CollabPeer } from '@/stores/collabStore';

/**
 * Binding one open file to a shared document.
 *
 * `MonacoBinding` is y-monaco's: it keeps a `Y.Text` and a Monaco model equal
 * in both directions, and renders remote carets and selections from awareness.
 * Using it rather than writing the reconciliation here is the same decision as
 * using Yjs at all — the interesting failures in this problem are subtle, and
 * a hand-rolled binding gets them wrong quietly.
 *
 * **The save path is untouched.** Monaco's own change event still fires for a
 * remote edit, so the editor writes it to the file store exactly as it writes a
 * local one, and everything downstream — persistence, the agent's view of the
 * file, the bundler — keeps working without knowing collaboration exists.
 *
 * **Nothing is shared until it is safe to share it.** The document is created
 * in `bootstrapping`, and the caller keeps the editor read-only until the
 * status settles: typing into a document that is about to be replaced by a
 * peer's copy is how a person's first sentence disappears.
 */

export interface BindingHandle {
  destroy: () => void;
  status: () => CollabStatus;
}

export interface BindOptions {
  client: SupabaseClient;
  projectId: string;
  path: string;
  model: editor.ITextModel;
  /** The editors whose carets are published. Usually just the one. */
  editors: editor.IStandaloneCodeEditor[];
  identity: { userId: string; displayName: string };
  /** Content used only if this tab turns out to be the first peer. */
  initialText: () => string;
}

/** Read awareness into the peer list the UI renders. */
function peersFrom(session: DocumentSession): CollabPeer[] {
  const peers: CollabPeer[] = [];
  const self = session.doc.clientID;
  for (const [clientId, state] of session.awareness.getStates()) {
    if (clientId === self) continue;
    const user = (state as { user?: { userId?: unknown; displayName?: unknown; colour?: unknown } })
      ?.user;
    // Everything here came from another client, so nothing is assumed.
    const userId = typeof user?.userId === 'string' ? user.userId.slice(0, 64) : '';
    if (!userId) continue;
    peers.push({
      clientId,
      userId,
      displayName:
        typeof user?.displayName === 'string' && user.displayName.trim()
          ? user.displayName.trim().slice(0, 80)
          : 'Someone',
      colour: typeof user?.colour === 'string' && /^#[0-9a-f]{6}$/i.test(user.colour)
        ? user.colour
        : colourFor(userId),
    });
  }
  return peers;
}

export function bindSharedDocument(options: BindOptions): BindingHandle {
  const store = useCollabStore.getState();
  store.beginSession(options.path);

  const session = openDocumentSession({
    client: options.client,
    projectId: options.projectId,
    path: options.path,
    identity: {
      userId: options.identity.userId,
      displayName: options.identity.displayName,
      colour: colourFor(options.identity.userId),
    },
    initialText: options.initialText,
    onStatus: (status, detail) => {
      // The session may outlive this file if a person switched tabs quickly.
      if (useCollabStore.getState().path !== options.path) return;
      useCollabStore.getState().setStatus(status, detail);
    },
  });

  const binding = new MonacoBinding(
    session.text,
    options.model,
    new Set(options.editors),
    session.awareness as never,
  );

  const publishPeers = () => {
    if (useCollabStore.getState().path !== options.path) return;
    useCollabStore.getState().setPeers(peersFrom(session));
  };
  session.awareness.on('change', publishPeers);
  publishPeers();

  return {
    status: session.status,
    destroy() {
      session.awareness.off('change', publishPeers);
      binding.destroy();
      session.destroy();
      if (useCollabStore.getState().path === options.path) {
        useCollabStore.getState().endSession();
      }
    },
  };
}
