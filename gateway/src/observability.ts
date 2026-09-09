import type { ErrorCode } from '../../src/lib/terminal/protocol.ts';

/**
 * Structured events, and the one rule that makes them safe to keep.
 *
 * This process holds a Supabase service-role key, users' access tokens, and
 * whatever a container prints. Any of those reaching a log is the incident, so
 * redaction is not a convention here — every value is put through
 * {@link redact} on its way out, and the log helper is the only way to write to
 * stdout. Terminal *content* is never an event field at all: sizes and counts
 * describe a stream well enough for operations, and a "first 100 bytes of
 * output" field would eventually contain somebody's password.
 */

export type EventName =
  | 'gateway_started'
  | 'container_created'
  | 'container_started'
  | 'container_stopped'
  | 'container_error'
  | 'container_expired'
  | 'terminal_connected'
  | 'terminal_disconnected'
  | 'terminal_rejected'
  | 'session_attached'
  | 'process_started'
  | 'process_exited'
  | 'sync_started'
  | 'sync_completed'
  | 'sync_failed'
  | 'sync_conflict'
  | 'port_opened'
  | 'port_closed'
  | 'port_denied'
  | 'resource_limit_hit'
  | 'protocol_violation';

export interface EventFields {
  /** Ties every line of one connection together. */
  correlationId?: string;
  userId?: string;
  projectId?: string;
  containerId?: string;
  sessionId?: string;
  code?: ErrorCode;
  /** Short, safe, operator-facing. Never a stack, never a credential. */
  reason?: string;
  durationMs?: number;
  bytes?: number;
  files?: number;
  port?: number;
  runtime?: string;
  status?: string;
  exitCode?: number | null;
  signal?: string | null;
}

/**
 * Values that must never appear in a log line, whatever field they arrive in.
 *
 * Matched on the rendered value rather than the field name, because the field
 * that leaks a token is never the one called `token` — it is `reason`, carrying
 * an upstream error that quoted the request.
 */
const SECRET_SHAPES: Array<[RegExp, string]> = [
  [/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/g, '[jwt]'],
  [/gh[pousr]_[A-Za-z0-9]{20,}/g, '[github-token]'],
  [/github_pat_[A-Za-z0-9_]{20,}/g, '[github-token]'],
  [/AIza[0-9A-Za-z_-]{20,}/g, '[api-key]'],
  [/sk-[A-Za-z0-9-]{20,}/g, '[api-key]'],
  [/\b[A-Za-z0-9+/]{60,}={0,2}\b/g, '[redacted]'],
];

export function redact(value: string): string {
  let out = value;
  for (const [shape, replacement] of SECRET_SHAPES) out = out.replace(shape, replacement);
  return out;
}

export interface Logger {
  event(name: EventName, fields?: EventFields): void;
  /** For a fault an operator must see. Still redacted, still never a stack. */
  problem(name: EventName, fields: EventFields): void;
}

/** Where a log line goes. Injectable so a test can read what was written. */
export type Sink = (line: string) => void;

export function createLogger(sink: Sink = (line) => process.stdout.write(`${line}\n`)): Logger {
  const write = (level: 'info' | 'error', name: EventName, fields: EventFields = {}) => {
    const safe: Record<string, unknown> = { level, event: name, at: new Date().toISOString() };
    for (const [key, value] of Object.entries(fields)) {
      if (value === undefined) continue;
      safe[key] = typeof value === 'string' ? redact(value).slice(0, 400) : value;
    }
    sink(JSON.stringify(safe));
  };
  return {
    event: (name, fields) => write('info', name, fields),
    problem: (name, fields) => write('error', name, fields),
  };
}

/** Short, unguessable, and safe in a log. Not a security token. */
export function correlationId(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
}
