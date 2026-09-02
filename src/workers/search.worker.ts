/// <reference lib="webworker" />
import { searchContents, type SearchOptions, type SearchOutcome } from '@/lib/search';

/**
 * Runs project-wide content search off the main thread. A regex over a few
 * hundred files is fast, but on a big import it is enough to drop frames while
 * the user is still typing.
 */

interface Request {
  id: number;
  files: Record<string, string>;
  options: SearchOptions;
}

type Response =
  | { id: number; ok: true; result: SearchOutcome }
  | { id: number; ok: false; error: string };

self.onmessage = (event: MessageEvent<Request>) => {
  const { id, files, options } = event.data;
  let response: Response;
  try {
    response = { id, ok: true, result: searchContents(files, options) };
  } catch (error) {
    response = { id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  (self as unknown as Worker).postMessage(response);
};
