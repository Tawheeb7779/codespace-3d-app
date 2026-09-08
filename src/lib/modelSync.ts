/**
 * Deciding what the editor actually has to reconcile.
 *
 * The editor keeps a Monaco model per project file so language services can see
 * across files. Keeping those in step with the store is the hot path: the store
 * replaces its file map on every keystroke, so this runs on every keystroke,
 * and doing O(project) work there is felt directly as typing latency.
 *
 * The saving grace is that a write replaces the *map* but keeps the very same
 * string object for every file it did not touch. Comparing strings with `!==`
 * is a value comparison, but engines settle the equal-reference case without
 * looking at characters, so the untouched files cost a pointer check each and
 * no model is read at all — the difference between comparing one file and
 * materialising the text of nine hundred.
 *
 * Kept separate from the component because it is where the correctness lives,
 * and it deserves tests that do not need an editor to run.
 */

/**
 * Paths whose content differs from the last sync, including new ones.
 *
 * A file whose text is equal is skipped even if the string was rebuilt: the
 * model already holds that text, so there is nothing to reconcile.
 */
export function changedPaths(
  previous: Record<string, string>,
  next: Record<string, string>,
): string[] {
  const changed: string[] = [];
  for (const path in next) {
    if (previous[path] !== next[path]) changed.push(path);
  }
  return changed;
}

/**
 * Whether any path disappeared, so the caller knows to sweep disposed models.
 *
 * Answered separately, and cheaply, because it is almost always false — a
 * keystroke never deletes a file — and the sweep it guards has to walk every
 * live model.
 */
export function hasRemovals(
  previous: Record<string, string>,
  next: Record<string, string>,
): boolean {
  for (const path in previous) {
    if (!(path in next)) return true;
  }
  return false;
}
