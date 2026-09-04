import type { ActivityAction, ActivityEvent } from '@/types';

/**
 * The project activity timeline.
 *
 * Two constraints shape this. First, the record is meant to be persisted
 * server-side eventually, where it is readable by every member of a project —
 * so nothing that reaches it may carry a secret. Second, the actions are a
 * closed set rather than free text, so a caller cannot smuggle arbitrary
 * content into a shared log by naming an event after it.
 *
 * `subject` is the one free-text field, and it goes through `redact` on the
 * way in: a bounded, single-line string with anything that looks like a
 * credential removed. That is belt and braces — no caller passes a secret
 * today — but the field is exactly where one would eventually leak.
 */

export const ACTIVITY_LABELS: Record<ActivityAction, string> = {
  'project.created': 'created the project',
  'project.renamed': 'renamed the project',
  'project.archived': 'archived the project',
  'project.restored': 'restored the project',
  'project.visibility': 'changed who can see the project',
  'branch.created': 'created a branch',
  'branch.switched': 'switched branch',
  'branch.deleted': 'deleted a branch',
  'commit.created': 'committed',
  'remote.pushed': 'pushed to GitHub',
  'remote.pulled': 'pulled from GitHub',
  'build.completed': 'ran a build',
  'agent.started': 'started an assistant task',
  'agent.completed': 'finished an assistant task',
  'member.added': 'added a member',
  'member.removed': 'removed a member',
  'member.role': 'changed a role',
};

/** Longest subject kept. A timeline entry is a label, not a document. */
export const MAX_SUBJECT = 120;

/**
 * Patterns that must never reach a shared timeline.
 *
 * Matched against the whole subject rather than word by word, because the
 * dangerous shapes (a JWT, a GitHub token) contain no spaces and would survive
 * any per-word filter.
 */
const SECRET_PATTERNS: RegExp[] = [
  // GitHub tokens, old and new formats.
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  // Anthropic and OpenAI style keys.
  /\bsk-[A-Za-z0-9-]{16,}\b/g,
  // Anything JWT-shaped: three base64url segments.
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  // `KEY=value` and `token: value` pairs, whatever the value looks like.
  /\b[A-Z0-9_]*(?:SECRET|TOKEN|KEY|PASSWORD|PASSWD|CREDENTIAL)[A-Z0-9_]*\s*[=:]\s*\S+/gi,
  // A URL carrying credentials in its authority.
  /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+:[^\s/@]+@\S+/gi,
];

const REDACTED = '[redacted]';

/**
 * Make a subject safe to store and show.
 *
 * Collapses whitespace (a timeline row is one line), removes credential-shaped
 * runs, and truncates. Returns an empty string for anything that is not a
 * string, so a malformed caller cannot write `undefined` into the log.
 */
export function redact(subject: unknown): string {
  if (typeof subject !== 'string') return '';
  let text = subject.replace(/\s+/g, ' ').trim();
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    text = text.replace(pattern, REDACTED);
  }
  return text.length > MAX_SUBJECT ? `${text.slice(0, MAX_SUBJECT - 1)}…` : text;
}

export interface ActivityInput {
  projectId: string;
  actorId: string;
  actorName: string;
  action: ActivityAction;
  subject?: string;
}

/** Build an event, with the subject already redacted and bounded. */
export function activityEvent(input: ActivityInput, id: string, now = Date.now()): ActivityEvent {
  return {
    id,
    projectId: input.projectId,
    actorId: input.actorId,
    actorName: redact(input.actorName) || 'Someone',
    action: input.action,
    subject: redact(input.subject),
    createdAt: now,
  };
}

/** One line of prose for a timeline row. */
export function describeActivity(event: ActivityEvent): string {
  const label = ACTIVITY_LABELS[event.action] ?? 'did something';
  return event.subject ? `${label} — ${event.subject}` : label;
}

/** Newest first, capped: the timeline is a recent view, not an archive. */
export function mergeActivity(
  existing: ActivityEvent[],
  incoming: ActivityEvent[],
  limit: number,
): ActivityEvent[] {
  const seen = new Set<string>();
  const all = [...incoming, ...existing]
    .filter((event) => {
      if (seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    })
    .sort((a, b) => b.createdAt - a.createdAt);
  return all.slice(0, limit);
}
