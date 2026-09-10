import { supabase } from '@/lib/supabase';

/**
 * Comments on a project's code.
 *
 * A thin, typed layer over one table. It is deliberately not part of
 * `ProjectRepository`: that interface has a local IndexedDB implementation, and
 * a "comment" that only this browser can see is not a comment — it is a note to
 * self wearing the clothes of a conversation. Rather than give the local
 * repository a method it would have to fake, comments are a feature of a
 * deployment that has a shared backend, and the panel says so when there is
 * none.
 *
 * **Authorship is the database's to decide.** Every insert here passes the
 * caller's own id, and the RLS policy independently requires
 * `author_id = auth.uid()` while a trigger refuses any later change to it. That
 * is three layers for one property, and it is the right number: a comment
 * attributed to the wrong person is a forged record in a conversation people
 * make decisions from.
 *
 * **Mentions are resolved to ids before they are stored.** A body keeps the
 * text somebody typed; `mentions` is the machine-readable half, so "what was I
 * named in?" is an index lookup rather than a scan of every comment in the
 * project.
 */

export interface Comment {
  id: string;
  projectId: string;
  parentId: string | null;
  authorId: string;
  authorName: string;
  path: string;
  line: number | null;
  body: string;
  mentions: string[];
  resolvedAt: number | null;
  createdAt: number;
}

/** One thread: its opening comment and the replies under it. */
export interface CommentThread {
  root: Comment;
  replies: Comment[];
}

interface Row {
  id: string;
  project_id: string;
  parent_id: string | null;
  author_id: string;
  path: string;
  line: number | null;
  body: string;
  mentions: string[] | null;
  resolved_at: string | null;
  created_at: string;
  profiles?: { display_name?: string | null; email?: string | null } | null;
}

function toComment(row: Row): Comment {
  return {
    id: row.id,
    projectId: row.project_id,
    parentId: row.parent_id,
    authorId: row.author_id,
    // A profile row may not have joined — a deleted account, or a row read
    // through a realtime event, which carries no join at all.
    authorName: row.profiles?.display_name || row.profiles?.email || 'Someone',
    path: row.path ?? '',
    line: row.line,
    body: row.body,
    mentions: row.mentions ?? [],
    resolvedAt: row.resolved_at ? Date.parse(row.resolved_at) : null,
    createdAt: Date.parse(row.created_at),
  };
}

const SELECT = 'id, project_id, parent_id, author_id, path, line, body, mentions, resolved_at, created_at, profiles:author_id (display_name, email)';

/** Newest threads first, capped: a panel is not an archive. */
const MAX_COMMENTS = 500;

export async function listComments(projectId: string): Promise<Comment[]> {
  if (!supabase) throw new Error('Comments need a Supabase project.');
  const { data, error } = await supabase
    .from('project_comments')
    .select(SELECT)
    .eq('project_id', projectId)
    .order('created_at', { ascending: true })
    .limit(MAX_COMMENTS);
  if (error) throw new Error(error.message);
  return (data as unknown as Row[]).map(toComment);
}

export interface NewComment {
  projectId: string;
  authorId: string;
  body: string;
  path?: string;
  line?: number | null;
  parentId?: string | null;
  mentions?: string[];
}

export async function addComment(input: NewComment): Promise<Comment> {
  if (!supabase) throw new Error('Comments need a Supabase project.');
  const body = input.body.trim();
  if (!body) throw new Error('A comment needs something in it.');

  const { data, error } = await supabase
    .from('project_comments')
    .insert({
      project_id: input.projectId,
      // Sent, and independently required by the policy. Not trusted from here.
      author_id: input.authorId,
      parent_id: input.parentId ?? null,
      // A reply belongs to its thread's anchor, never its own.
      path: input.parentId ? '' : (input.path ?? ''),
      line: input.parentId ? null : (input.line ?? null),
      body: body.slice(0, 4000),
      mentions: (input.mentions ?? []).slice(0, 50),
    })
    .select(SELECT)
    .single();
  if (error) throw new Error(error.message);
  return toComment(data as unknown as Row);
}

export async function editComment(id: string, body: string): Promise<void> {
  if (!supabase) throw new Error('Comments need a Supabase project.');
  const clean = body.trim();
  if (!clean) throw new Error('A comment needs something in it.');
  const { error } = await supabase
    .from('project_comments')
    .update({ body: clean.slice(0, 4000) })
    .eq('id', id);
  if (error) throw new Error(error.message);
}

/**
 * Resolve or reopen a thread.
 *
 * `resolved_by` is set together with `resolved_at` because the table refuses
 * one without the other — a thread that is closed by nobody is a record with a
 * hole in it.
 */
export async function setResolved(id: string, resolverId: string, resolved: boolean): Promise<void> {
  if (!supabase) throw new Error('Comments need a Supabase project.');
  const { error } = await supabase
    .from('project_comments')
    .update(
      resolved
        ? { resolved_at: new Date().toISOString(), resolved_by: resolverId }
        : { resolved_at: null, resolved_by: null },
    )
    .eq('id', id);
  if (error) throw new Error(error.message);
}

export async function deleteComment(id: string): Promise<void> {
  if (!supabase) throw new Error('Comments need a Supabase project.');
  const { error } = await supabase.from('project_comments').delete().eq('id', id);
  if (error) throw new Error(error.message);
}

/**
 * Group a flat list into threads, in the order they were opened.
 *
 * A reply whose parent is missing — deleted, or beyond the cap — becomes its
 * own thread rather than disappearing. Losing somebody's words because the
 * comment above them went away is worse than showing them slightly out of
 * place.
 */
export function toThreads(comments: Comment[]): CommentThread[] {
  const roots = comments.filter((comment) => !comment.parentId);
  const byId = new Set(roots.map((comment) => comment.id));
  const orphans = comments.filter(
    (comment) => comment.parentId && !byId.has(comment.parentId),
  );

  const threads: CommentThread[] = [...roots, ...orphans].map((root) => ({
    root,
    replies: comments
      .filter((comment) => comment.parentId === root.id)
      .sort((a, b) => a.createdAt - b.createdAt),
  }));

  return threads.sort((a, b) => a.root.createdAt - b.root.createdAt);
}

/** A person who can be named in a comment. */
export interface Mentionable {
  userId: string;
  displayName: string;
}

/**
 * Turn `@name` into ids, matching only people who are actually on the project.
 *
 * Anyone else named stays plain text: a mention that resolves to a stranger
 * would notify somebody who cannot read the code being discussed, and a
 * mention that resolves to nobody should not silently look like it worked.
 */
export function resolveMentions(body: string, members: Mentionable[]): string[] {
  const found = new Set<string>();
  // Longest names first, and each match is *consumed*. Sorting alone is not
  // enough: `includes` does not take the span it matched, so "@Amina Bello"
  // still contains "@Amina" and would notify a second person who was never
  // named. The matched characters are blanked out so a shorter name cannot
  // match inside a longer one that already did.
  const ordered = [...members]
    .filter((member) => member.displayName.trim())
    .sort((a, b) => b.displayName.length - a.displayName.length);
  let remaining = body.toLowerCase();

  for (const member of ordered) {
    const handle = `@${member.displayName.toLowerCase()}`;
    let at = remaining.indexOf(handle);
    if (at === -1) continue;
    found.add(member.userId);
    while (at !== -1) {
      remaining =
        remaining.slice(0, at) + '\u0000'.repeat(handle.length) + remaining.slice(at + handle.length);
      at = remaining.indexOf(handle);
    }
  }
  return [...found].slice(0, 50);
}

/** The `@name` fragment being typed at the caret, if any. */
export function mentionQuery(body: string, caret: number): string | null {
  const before = body.slice(0, caret);
  const at = before.lastIndexOf('@');
  if (at === -1) return null;
  // Must start a word: an email address is not a mention.
  if (at > 0 && !/\s/.test(before[at - 1])) return null;
  const fragment = before.slice(at + 1);
  // A newline ends it; a very long fragment is somebody typing prose.
  if (/[\n\r]/.test(fragment) || fragment.length > 40) return null;
  return fragment;
}
