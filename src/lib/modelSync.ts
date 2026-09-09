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

/**
 * The smallest span that turns one text into another.
 *
 * Used to apply a change as an *edit* rather than a replacement, which is the
 * difference between a file the container rewrote appearing under the cursor
 * and the person's undo history being thrown away. `setValue` is the obvious
 * call and it resets the undo stack, the cursor and the scroll position — fine
 * when the editor itself is the only writer, which stopped being true when a
 * real container started writing to the same tree.
 *
 * Returns null when the texts are identical, so the caller can do nothing at
 * all — the common case, since most reconciliations are the editor's own write
 * arriving back.
 *
 * Offsets, not line/column: the caller has the model and can convert, and
 * doing it here would mean reimplementing Monaco's position arithmetic.
 */
export function minimalEdit(
  current: string,
  next: string,
): { start: number; end: number; text: string } | null {
  if (current === next) return null;

  let prefix = 0;
  const shortest = Math.min(current.length, next.length);
  while (prefix < shortest && current.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix += 1;

  // The two scans must not overlap in the middle, or a repeated substring makes
  // the suffix consume characters the prefix already claimed and the resulting
  // range is inverted.
  let suffix = 0;
  const remaining = shortest - prefix;
  while (
    suffix < remaining &&
    current.charCodeAt(current.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  ) {
    suffix += 1;
  }

  return {
    start: prefix,
    end: current.length - suffix,
    text: next.slice(prefix, next.length - suffix),
  };
}
