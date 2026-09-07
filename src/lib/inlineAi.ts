import type { editor as MonacoEditor } from 'monaco-editor';
import { monaco as monacoApi } from '@/lib/monaco';
import { WORKFLOWS } from '@/lib/ai/workflows';
import { useAiStore } from '@/stores/aiStore';
import { useUIStore } from '@/stores/uiStore';

/**
 * The assistant's workflows, reachable from the code they are about.
 *
 * Every one of these already existed and already read the selection — they were
 * simply only reachable from the assistant panel, which meant highlighting a
 * function and asking about it took a trip across the window. Registering them
 * as editor actions changes where they are invoked, not what they do: the same
 * `runWorkflow` runs, against the same store, with the same approval rules.
 *
 * Only the workflows that operate on a piece of code are offered here. "Review
 * changes" is about the working tree rather than a selection, so it stays where
 * it makes sense and does not clutter a right-click on a function.
 */

/** Workflows that are about the code under the cursor. */
const INLINE = new Set(['explain', 'refactor', 'optimize', 'document', 'tests', 'debug']);

/** Where these sit in the editor's context menu, and in what order. */
const GROUP = 'ta-ai';

/**
 * Attach the actions to one editor instance.
 *
 * Returns a disposer, because Monaco keeps its own registry and an editor that
 * is torn down and rebuilt — every time a file opens — would otherwise
 * accumulate a duplicate set of menu entries per mount.
 */
export function registerInlineAi(instance: MonacoEditor.IStandaloneCodeEditor): () => void {
  const disposables = WORKFLOWS.filter((workflow) => INLINE.has(workflow.id)).map(
    (workflow, index) =>
      instance.addAction({
        id: `ta.ai.${workflow.id}`,
        label: `TA AI: ${workflow.label}`,
        contextMenuGroupId: GROUP,
        contextMenuOrder: index,
        // Only offer them when there is something highlighted. A workflow that
        // says "this selection" with nothing selected is a worse experience
        // than the action not being there.
        precondition: 'editorHasSelection',
        run: (editorInstance) => {
          const model = editorInstance.getModel();
          const selection = editorInstance.getSelection();
          if (!model || !selection) return;

          const highlighted = model.getValueInRange(selection);
          if (!highlighted.trim()) return;

          // The panel has to be visible before the turn starts, or the answer
          // arrives somewhere the user is not looking.
          useUIStore.getState().setSidebarPanel('assistant');
          useAiStore.getState().setSelection(highlighted);
          void useAiStore.getState().runWorkflow(workflow.id);
        },
      }),
  );

  return () => {
    for (const disposable of disposables) disposable.dispose();
  };
}

/**
 * The one action that is not a workflow: hand the selection over and type your
 * own question. It is the most-used shape of "ask about this", and routing it
 * through a workflow would put words in the user's mouth.
 */
export function registerAskAboutSelection(
  instance: MonacoEditor.IStandaloneCodeEditor,
): () => void {
  const action = instance.addAction({
    id: 'ta.ai.ask',
    label: 'TA AI: Ask about this selection',
    contextMenuGroupId: GROUP,
    contextMenuOrder: -1,
    precondition: 'editorHasSelection',
    // Not Shift+I: that chord is "format document" in the app keymap, and the
    // global dispatcher captures it on window before the editor is offered it,
    // so this action would never have run.
    keybindings: [monacoApi.KeyMod.CtrlCmd | monacoApi.KeyMod.Alt | monacoApi.KeyCode.KeyI],
    run: (editorInstance) => {
      const model = editorInstance.getModel();
      const selection = editorInstance.getSelection();
      if (!model || !selection) return;
      const highlighted = model.getValueInRange(selection);
      if (!highlighted.trim()) return;

      useAiStore.getState().setSelection(highlighted);
      useUIStore.getState().setSidebarPanel('assistant');
    },
  });
  return () => action.dispose();
}
