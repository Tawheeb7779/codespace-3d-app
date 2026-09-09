import type { ErrorCode } from '../../src/lib/terminal/protocol.ts';
import { FATAL_ERRORS } from '../../src/lib/terminal/protocol.ts';

/**
 * A fault with two audiences.
 *
 * `message` is written for the person at the terminal and is the only part that
 * crosses the wire. `detail` is for the operator and stays in this process. The
 * split is structural rather than a discipline, because the failure mode it
 * prevents — a stack trace, an internal hostname or a quoted request reaching a
 * browser — happens when someone reaches for the nearest string under pressure.
 */
export class GatewayError extends Error {
  readonly code: ErrorCode;
  readonly detail: string;

  constructor(code: ErrorCode, message: string, detail = '') {
    super(message);
    this.name = 'GatewayError';
    this.code = code;
    this.detail = detail;
  }

  get fatal(): boolean {
    return FATAL_ERRORS.includes(this.code);
  }
}

export const authError = (message = 'Sign in to use the container terminal.') =>
  new GatewayError('AUTH_ERROR', message);

export const permissionError = (message = 'You do not have access to this project.') =>
  new GatewayError('PERMISSION_ERROR', message);

export const protocolError = (detail: string) =>
  new GatewayError('PROTOCOL_ERROR', 'The connection sent something unexpected.', detail);

export const resourceLimit = (message: string, detail = '') =>
  new GatewayError('RESOURCE_LIMIT', message, detail);

/**
 * Turn anything thrown into something safe to send.
 *
 * The default deliberately discards the original message. An unexpected error
 * here is by definition one nobody has vetted for what it might contain.
 */
export function toGatewayError(error: unknown): GatewayError {
  if (error instanceof GatewayError) return error;
  const detail = error instanceof Error ? `${error.name}: ${error.message}` : 'unknown';
  return new GatewayError('INTERNAL_ERROR', 'Something went wrong. Try again.', detail);
}
