/**
 * Opening the preview in its own tab.
 *
 * The obvious implementation — `window.open(URL.createObjectURL(blob))` — is a
 * sandbox escape, and it was the one this file replaced. A `blob:` URL inherits
 * the origin of the page that minted it, so the project would run *as Forge*:
 * same `localStorage`, same IndexedDB, which between them hold every project's
 * source, the local account and the connected-repository records. Imported
 * third-party code, or code the assistant wrote, would have been able to read
 * and rewrite all of it.
 *
 * So the new tab is a host page of ours whose only content is the same
 * sandboxed frame the preview panel uses. Project code keeps the opaque origin
 * it has inside the IDE, and the document is handed over by assigning the
 * `srcdoc` *property* — never by building an HTML string, which is where an
 * escaping bug would otherwise live.
 */

/**
 * The single definition of what preview code is allowed to do.
 *
 * `allow-same-origin` is absent, and that absence is the whole security model:
 * with it the frame would rejoin this origin and every storage API would open
 * back up.
 */
export const PREVIEW_SANDBOX = 'allow-scripts allow-forms allow-modals allow-popups';

export type OpenPreviewResult = 'opened' | 'blocked' | 'unavailable';

/**
 * Render `doc` into a new tab. Returns why it did not open, if it did not.
 *
 * `opener` is a parameter so a test can drive this with a stub; production
 * callers pass the real `window`.
 */
export function openPreviewWindow(
  doc: string,
  title: string,
  opener: Pick<Window, 'open'> = window,
): OpenPreviewResult {
  // No `noopener`: this tab is our own page and we need to write into it. The
  // link back is severed below instead, which is stricter than the flag —
  // `noopener` would also have forced a fresh browsing context we cannot touch.
  const tab = opener.open('', '_blank');
  if (!tab) return 'blocked';

  const target = tab.document;
  if (!target?.body) {
    tab.close();
    return 'unavailable';
  }

  // The popup can reach back at `window.opener`; nothing needs that, so drop it.
  try {
    tab.opener = null;
  } catch {
    // Some engines make it read-only. The frame below is the real boundary.
  }

  target.title = title;
  target.body.style.margin = '0';
  target.body.style.background = '#fff';

  const frame = target.createElement('iframe');
  frame.setAttribute('sandbox', PREVIEW_SANDBOX);
  frame.setAttribute('title', title);
  frame.style.cssText = 'border:0;display:block;width:100vw;height:100vh';
  // A property assignment, so the document is never parsed as part of ours.
  frame.srcdoc = doc;
  target.body.appendChild(frame);
  return 'opened';
}
