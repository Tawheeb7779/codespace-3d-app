import { useEffect, useMemo, useRef, useState } from 'react';
import { AtSign, Check, MessageSquare, Reply, Trash2, Wifi, WifiOff } from 'lucide-react';
import { PanelHeader, EmptyState, ErrorState, SkeletonRows, Badge } from '@/components/ui/Primitives';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ide/FileIcon';
import { useCommentStore } from '@/stores/commentStore';
import { useMemberStore } from '@/stores/memberStore';
import { useAuthStore } from '@/stores/authStore';
import { useFileStore } from '@/stores/fileStore';
import { useEditorStore } from '@/stores/editorStore';
import { toast } from '@/stores/toastStore';
import { mentionQuery, resolveMentions, type CommentThread } from '@/lib/collab/comments';
import { basename } from '@/lib/vfs';
import { cx, errorMessage, formatTimeAgo } from '@/lib/utils';

/**
 * The conversation about this project's code.
 *
 * A comment is anchored to a file and, when it was written from the editor, to
 * a line — so clicking it goes to the code rather than describing where the
 * code is. Threads are one level deep, which is what a code review needs and
 * what fits in a panel this wide.
 *
 * `live` is the honest part. The list is maintained by database change events,
 * and when that stream drops the panel says the list may be behind rather than
 * letting a stale thread read as current. Somebody replying to a question that
 * was answered ten minutes ago is the failure this prevents.
 */

type Filter = 'all' | 'file' | 'mentions' | 'open';

function MentionBody({ body, names }: { body: string; names: string[] }) {
  /*
   * Highlight the names that were actually resolved.
   *
   * Only the people on the project: a `@someone` who is not a member stays
   * plain text, because a mention that looks live but notifies nobody is worse
   * than one that plainly did not match.
   */
  const parts = useMemo(() => {
    if (!names.length) return [body];
    const pattern = new RegExp(
      `(@(?:${names.map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')}))`,
      'gi',
    );
    return body.split(pattern);
  }, [body, names]);

  return (
    <span className="whitespace-pre-wrap break-words">
      {parts.map((part, index) =>
        part.startsWith('@') && names.some((name) => `@${name}`.toLowerCase() === part.toLowerCase()) ? (
          <span key={index} className="rounded-sm bg-accent-soft px-0.5 text-accent">
            {part}
          </span>
        ) : (
          <span key={index}>{part}</span>
        ),
      )}
    </span>
  );
}

function Composer({
  placeholder,
  busy,
  autoFocus,
  onSubmit,
  onCancel,
}: {
  placeholder: string;
  busy: boolean;
  autoFocus?: boolean;
  onSubmit: (body: string, mentions: string[]) => void;
  onCancel?: () => void;
}) {
  const members = useMemberStore((s) => s.members);
  const [body, setBody] = useState('');
  const [caret, setCaret] = useState(0);
  const ref = useRef<HTMLTextAreaElement>(null);

  const mentionable = useMemo(
    () =>
      members.map((member) => ({
        userId: member.userId,
        displayName: member.displayName || member.email,
      })),
    [members],
  );

  // Who is being typed at, if anyone. Only people on this project are offered.
  const query = mentionQuery(body, caret);
  const suggestions =
    query === null
      ? []
      : mentionable
          .filter((person) => person.displayName.toLowerCase().startsWith(query.toLowerCase()))
          .slice(0, 5);

  const insert = (name: string) => {
    const before = body.slice(0, caret);
    const at = before.lastIndexOf('@');
    const next = `${body.slice(0, at)}@${name} ${body.slice(caret)}`;
    setBody(next);
    setCaret(at + name.length + 2);
    ref.current?.focus();
  };

  const submit = () => {
    const text = body.trim();
    if (!text) return;
    onSubmit(text, resolveMentions(text, mentionable));
    setBody('');
  };

  return (
    <div className="relative">
      <textarea
        ref={ref}
        value={body}
        autoFocus={autoFocus}
        disabled={busy}
        placeholder={placeholder}
        rows={2}
        onChange={(event) => {
          setBody(event.target.value);
          setCaret(event.target.selectionStart ?? event.target.value.length);
        }}
        onSelect={(event) => setCaret(event.currentTarget.selectionStart ?? 0)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            submit();
          }
          if (event.key === 'Escape' && onCancel) onCancel();
        }}
        className="w-full resize-none rounded border border-line bg-surface-sunken px-2 py-1.5 text-base text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
      />

      {suggestions.length > 0 && (
        <ul className="absolute bottom-full z-10 mb-1 w-full overflow-hidden rounded-md border border-line bg-surface-overlay shadow-pop">
          {suggestions.map((person) => (
            <li key={person.userId}>
              <button
                type="button"
                onMouseDown={(event) => {
                  // `mousedown`, so the textarea does not lose focus first and
                  // take the caret position with it.
                  event.preventDefault();
                  insert(person.displayName);
                }}
                className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-sm text-ink-muted hover:bg-surface-raised hover:text-ink"
              >
                <AtSign aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" />
                <span className="truncate">{person.displayName}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="mt-1.5 flex gap-1.5">
        <Button size="xs" variant="primary" loading={busy} disabled={!body.trim()} onClick={submit}>
          Comment
        </Button>
        {onCancel && (
          <Button size="xs" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}

function Thread({
  thread,
  names,
  userId,
  canAdminister,
  onReveal,
}: {
  thread: CommentThread;
  names: string[];
  userId: string;
  canAdminister: boolean;
  onReveal: (path: string, line: number | null) => void;
}) {
  const { post, resolve, remove } = useCommentStore();
  const [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState(false);
  const resolved = thread.root.resolvedAt !== null;

  const guard = async (label: string, action: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      toast.error(label, errorMessage(error));
    } finally {
      setBusy(false);
    }
  };

  const mine = (authorId: string) => authorId === userId;

  return (
    <article className={cx('border-b border-line px-2.5 py-2', resolved && 'opacity-60')}>
      {thread.root.path && (
        <button
          type="button"
          onClick={() => onReveal(thread.root.path, thread.root.line)}
          className="mb-1 flex w-full min-w-0 items-center gap-1.5 text-left text-sm text-ink-faint hover:text-ink"
        >
          <FileIcon path={thread.root.path} />
          <span className="truncate">{basename(thread.root.path)}</span>
          {thread.root.line !== null && (
            <span className="shrink-0 font-mono tabular-nums">:{thread.root.line}</span>
          )}
        </button>
      )}

      <div className="flex items-start gap-2">
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-soft text-2xs font-medium text-accent">
          {thread.root.authorName.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-0 flex-1">
          <p className="flex items-baseline gap-1.5 text-sm">
            <span className="truncate font-medium text-ink">{thread.root.authorName}</span>
            <span className="shrink-0 text-ink-faint">{formatTimeAgo(thread.root.createdAt)}</span>
            {resolved && <Badge tone="positive">resolved</Badge>}
          </p>
          <p className="mt-0.5 text-base text-ink-muted">
            <MentionBody body={thread.root.body} names={names} />
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-0.5">
          <IconButton
            label={resolved ? 'Reopen this thread' : 'Resolve this thread'}
            size="xs"
            disabled={busy || !(mine(thread.root.authorId) || canAdminister)}
            active={resolved}
            icon={<Check className="h-3 w-3" />}
            onClick={() =>
              void guard('Could not change the thread', () =>
                resolve(thread.root.id, userId, !resolved),
              )
            }
          />
          {mine(thread.root.authorId) || canAdminister ? (
            <IconButton
              label="Delete this thread"
              size="xs"
              disabled={busy}
              icon={<Trash2 className="h-3 w-3" />}
              onClick={() => void guard('Could not delete', () => remove(thread.root.id))}
            />
          ) : null}
        </div>
      </div>

      {thread.replies.map((reply) => (
        <div key={reply.id} className="mt-1.5 flex items-start gap-2 pl-6">
          <span className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-surface-raised text-2xs text-ink-muted">
            {reply.authorName.slice(0, 1).toUpperCase()}
          </span>
          <div className="min-w-0 flex-1">
            <p className="flex items-baseline gap-1.5 text-sm">
              <span className="truncate text-ink">{reply.authorName}</span>
              <span className="shrink-0 text-ink-faint">{formatTimeAgo(reply.createdAt)}</span>
            </p>
            <p className="text-base text-ink-muted">
              <MentionBody body={reply.body} names={names} />
            </p>
          </div>
          {(mine(reply.authorId) || canAdminister) && (
            <IconButton
              label="Delete this reply"
              size="xs"
              disabled={busy}
              icon={<Trash2 className="h-3 w-3" />}
              onClick={() => void guard('Could not delete', () => remove(reply.id))}
            />
          )}
        </div>
      ))}

      {replying ? (
        <div className="mt-1.5 pl-6">
          <Composer
            autoFocus
            busy={busy}
            placeholder="Reply…"
            onCancel={() => setReplying(false)}
            onSubmit={(body, mentions) =>
              void guard('Could not reply', async () => {
                await post({ authorId: userId, body, parentId: thread.root.id, mentions });
                setReplying(false);
              })
            }
          />
        </div>
      ) : (
        !resolved && (
          <button
            type="button"
            onClick={() => setReplying(true)}
            className="tap-target mt-1 flex items-center gap-1 pl-6 text-sm text-ink-faint hover:text-ink"
          >
            <Reply aria-hidden className="h-3 w-3" />
            <span>Reply</span>
          </button>
        )
      )}
    </article>
  );
}

export function CommentsPanel() {
  const { comments, loading, error, live, load, post, threads, threadsFor, mentioning } =
    useCommentStore();
  const projectId = useFileStore((s) => s.projectId);
  const user = useAuthStore((s) => s.user);
  const activePath = useEditorStore((s) => s.activePath);
  const reveal = useEditorStore((s) => s.revealLocation);
  const members = useMemberStore((s) => s.members);
  const canWrite = useFileStore((s) => s.canWrite());
  const canAdminister = useMemberStore(
    (s) => s.members.find((member) => member.userId === user?.id)?.role === 'admin',
  );

  const [filter, setFilter] = useState<Filter>('all');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (projectId) void load(projectId);
  }, [projectId, load]);

  const names = useMemo(
    () => members.map((member) => member.displayName || member.email).filter(Boolean),
    [members],
  );

  const visible = useMemo(() => {
    if (filter === 'file') return activePath ? threadsFor(activePath) : [];
    if (filter === 'mentions') return user ? mentioning(user.id) : [];
    const all = threads();
    return filter === 'open' ? all.filter((thread) => thread.root.resolvedAt === null) : all;
    // `comments` is the real input; the selectors read it from the store.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, comments, activePath, user?.id]);

  if (!user) {
    return (
      <div className="flex h-full flex-col">
        <PanelHeader title="Comments" />
        <EmptyState title="Sign in to join the discussion" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title="Comments"
        actions={
          live ? (
            <Wifi aria-label="Live" className="h-3 w-3 text-positive" />
          ) : (
            <WifiOff aria-label="Not live" className="h-3 w-3 text-ink-faint" />
          )
        }
      />

      <div role="tablist" aria-label="Comment filter" className="flex shrink-0 border-b border-line">
        {(
          [
            ['all', 'All'],
            ['open', 'Open'],
            ['file', 'This file'],
            ['mentions', 'For me'],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            role="tab"
            type="button"
            aria-selected={filter === value}
            onClick={() => setFilter(value)}
            className={cx(
              'tap-target flex-1 px-2 py-1.5 text-sm transition-colors',
              filter === value
                ? 'border-b-2 border-accent text-ink'
                : 'border-b-2 border-transparent text-ink-muted hover:text-ink',
            )}
          >
            {label}
          </button>
        ))}
      </div>

      {!live && !loading && !error && (
        <p className="border-b border-caution/40 bg-caution/5 px-2.5 py-1 text-sm text-caution">
          <span>Not receiving live updates. This list may be behind.</span>
        </p>
      )}

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {loading ? (
          <SkeletonRows rows={5} />
        ) : error ? (
          <ErrorState
            title="Comments are unavailable"
            detail={error}
            onRetry={projectId ? () => void load(projectId) : undefined}
          />
        ) : !visible.length ? (
          <EmptyState
            icon={<MessageSquare className="h-4 w-4" />}
            title={
              filter === 'mentions'
                ? 'Nobody has named you'
                : filter === 'file'
                  ? 'Nothing on this file'
                  : filter === 'open'
                    ? 'No open threads'
                    : 'No comments yet'
            }
            description={
              filter === 'all'
                ? 'Start a thread below. Name a teammate with @ to bring them in.'
                : undefined
            }
          />
        ) : (
          visible.map((thread) => (
            <Thread
              key={thread.root.id}
              thread={thread}
              names={names}
              userId={user.id}
              canAdminister={canAdminister}
              onReveal={(path, line) => reveal(path, line ?? 1, 1)}
            />
          ))
        )}
      </div>

      {canWrite && !error && (
        <div className="shrink-0 border-t border-line p-2.5">
          <Composer
            busy={busy}
            placeholder={
              activePath ? `Comment on ${basename(activePath)}…` : 'Comment on this project…'
            }
            onSubmit={(body, mentions) => {
              setBusy(true);
              void post({ authorId: user.id, body, path: activePath ?? '', mentions })
                .catch((failure: unknown) => toast.error('Could not comment', errorMessage(failure)))
                .finally(() => setBusy(false));
            }}
          />
        </div>
      )}
    </div>
  );
}
