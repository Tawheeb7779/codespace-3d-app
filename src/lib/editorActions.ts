import { monaco } from '@/lib/monaco';

/**
 * Editor commands invoked from outside a React component (command palette,
 * keyboard shortcuts, save-with-format). Kept out of the component file so
 * fast refresh can treat that module as components only.
 */

/** The editor the user is working in, or the only one on screen. */
function activeEditor(): monaco.editor.ICodeEditor | null {
  return (
    monaco.editor.getEditors().find((candidate) => candidate.hasTextFocus()) ??
    monaco.editor.getEditors()[0] ??
    null
  );
}

/**
 * Run one of Monaco's own actions against the focused editor.
 *
 * Everything exposed through this is behaviour Monaco already implements
 * correctly — multi-cursor, folding, symbol rename, selection expansion.
 * Reimplementing any of it would mean a second, worse version of a solved
 * problem, so this only routes to it and reports honestly when a language
 * cannot support the action.
 */
export async function runEditorAction(id: string): Promise<boolean> {
  const instance = activeEditor();
  if (!instance) return false;
  const action = instance.getAction(id);
  if (!action) return false;
  // Monaco keeps unsupported actions registered but disabled — asking first is
  // what turns "nothing happened" into a message the user can act on.
  if (typeof action.isSupported === 'function' && !action.isSupported()) return false;
  instance.focus();
  await action.run();
  return true;
}

/** Format the active document; returns false when the language has no formatter. */
export function formatDocument(): Promise<boolean> {
  return runEditorAction('editor.action.formatDocument');
}

/**
 * Editor actions surfaced as commands.
 *
 * Ids are Monaco's own. `needsLanguageService` marks the ones that only work
 * where a language service is running — TypeScript and JavaScript here — so
 * the palette can explain a refusal instead of appearing to do nothing.
 */
export interface EditorCommand {
  id: string;
  label: string;
  action: string;
  keys?: string;
  needsLanguageService?: boolean;
}

export const EDITOR_COMMANDS: EditorCommand[] = [
  { id: 'editor.formatSelection', label: 'Format selection', action: 'editor.action.formatSelection' },
  { id: 'editor.commentLine', label: 'Toggle line comment', action: 'editor.action.commentLine' },
  { id: 'editor.blockComment', label: 'Toggle block comment', action: 'editor.action.blockComment' },
  { id: 'editor.duplicateLine', label: 'Duplicate line', action: 'editor.action.duplicateSelection' },
  { id: 'editor.moveLineUp', label: 'Move line up', action: 'editor.action.moveLinesUpAction' },
  { id: 'editor.moveLineDown', label: 'Move line down', action: 'editor.action.moveLinesDownAction' },
  { id: 'editor.deleteLine', label: 'Delete line', action: 'editor.action.deleteLines' },
  { id: 'editor.expandSelection', label: 'Expand selection', action: 'editor.action.smartSelect.expand' },
  { id: 'editor.shrinkSelection', label: 'Shrink selection', action: 'editor.action.smartSelect.shrink' },
  { id: 'editor.addCursorBelow', label: 'Add cursor below', action: 'editor.action.insertCursorBelow' },
  { id: 'editor.addCursorAbove', label: 'Add cursor above', action: 'editor.action.insertCursorAbove' },
  { id: 'editor.selectAllOccurrences', label: 'Select all occurrences', action: 'editor.action.selectHighlights' },
  { id: 'editor.foldAll', label: 'Fold all', action: 'editor.foldAll' },
  { id: 'editor.unfoldAll', label: 'Unfold all', action: 'editor.unfoldAll' },
  { id: 'editor.goToBracket', label: 'Go to matching bracket', action: 'editor.action.jumpToBracket' },
  {
    id: 'editor.goToDefinition',
    label: 'Go to definition',
    action: 'editor.action.revealDefinition',
    needsLanguageService: true,
  },
  {
    id: 'editor.findReferences',
    label: 'Find all references',
    action: 'editor.action.goToReferences',
    needsLanguageService: true,
  },
  {
    id: 'editor.renameSymbol',
    label: 'Rename symbol',
    action: 'editor.action.rename',
    needsLanguageService: true,
  },
  {
    id: 'editor.quickFix',
    label: 'Quick fix',
    action: 'editor.action.quickFix',
    needsLanguageService: true,
  },
];
