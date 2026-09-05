import { describe, expect, it } from 'vitest';
import { PREVIEW_SANDBOX, openPreviewWindow } from '@/lib/previewWindow';

/**
 * Opening the preview in a new tab.
 *
 * This existed as `window.open(URL.createObjectURL(blob))`, which is a sandbox
 * escape: a `blob:` URL inherits the origin of the page that created it, so the
 * project ran as Forge and could read the IndexedDB holding every project, the
 * local account and the connected-repository records. The assertions below are
 * about that: the document must reach an iframe whose sandbox withholds
 * `allow-same-origin`, and it must get there as a property rather than as text
 * spliced into markup of ours.
 */

function fakeTab() {
  const doc = document.implementation.createHTMLDocument('');
  const tab = { document: doc, opener: {} as unknown, closed: false, close: () => {} };
  return { tab, doc, opener: { open: () => tab as unknown as Window } };
}

describe('opening the preview in a new tab', () => {
  it('never hands project code this origin', () => {
    const { doc, opener } = fakeTab();
    expect(openPreviewWindow('<h1>hi</h1>', 'Demo', opener)).toBe('opened');

    const frame = doc.querySelector('iframe');
    expect(frame).not.toBeNull();
    const sandbox = frame!.getAttribute('sandbox') ?? '';
    expect(sandbox).toBe(PREVIEW_SANDBOX);
    // The whole boundary is this one absence.
    expect(sandbox).not.toContain('allow-same-origin');
  });

  it('puts the document in the frame, not in the page around it', () => {
    const { doc, opener } = fakeTab();
    const project = '<script>alert(1)</script><p>body</p>';
    openPreviewWindow(project, 'Demo', opener);

    const frame = doc.querySelector('iframe')!;
    expect(frame.srcdoc).toBe(project);
    // Nothing of the project was parsed as part of the host page: the only
    // element in the body is the frame itself.
    expect(doc.body.children).toHaveLength(1);
    expect(doc.querySelector('script')).toBeNull();
  });

  it('severs the link back to the IDE tab', () => {
    const { tab, opener } = fakeTab();
    openPreviewWindow('<p>x</p>', 'Demo', opener);
    expect(tab.opener).toBeNull();
  });

  it('reports a blocked popup rather than failing silently', () => {
    expect(openPreviewWindow('<p>x</p>', 'Demo', { open: () => null })).toBe('blocked');
  });

  it('names the tab after the project', () => {
    const { doc, opener } = fakeTab();
    openPreviewWindow('<p>x</p>', 'Landing — Forge preview', opener);
    expect(doc.title).toBe('Landing — Forge preview');
  });
});
