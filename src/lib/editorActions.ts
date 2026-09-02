import { monaco } from '@/lib/monaco';

/**
 * Editor commands invoked from outside a React component (command palette,
 * keyboard shortcuts, save-with-format). Kept out of the component file so
 * fast refresh can treat that module as components only.
 */

/** Format the active document; returns false when the language has no formatter. */
export async function formatDocument(): Promise<boolean> {
  const instance = monaco.editor
    .getEditors()
    .find((candidate) => candidate.hasTextFocus()) ?? monaco.editor.getEditors()[0];
  if (!instance) return false;
  const action = instance.getAction('editor.action.formatDocument');
  if (!action) return false;
  await action.run();
  return true;
}
