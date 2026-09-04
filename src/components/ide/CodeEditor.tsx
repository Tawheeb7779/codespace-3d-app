import { useCallback, useEffect, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { setupMonaco, monaco as monacoApi } from '@/lib/monaco';
import { monacoLanguage } from '@/lib/languages';
import { useFileStore } from '@/stores/fileStore';
import { useAiStore } from '@/stores/aiStore';
import { useEditorStore } from '@/stores/editorStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useMonacoTheme } from '@/hooks/useTheme';
import { Spinner } from '@/components/ui/Primitives';
import type { Problem } from '@/types';
import { uid } from '@/lib/utils';

/**
 * Monaco bound to the virtual file system.
 *
 * Every open file gets its own model keyed by an in-memory URI, which is what
 * lets TypeScript resolve imports between project files and gives each tab an
 * independent undo stack and view state.
 */

const SEVERITY: Record<number, Problem['severity']> = {
  8: 'error',
  4: 'warning',
  2: 'info',
  1: 'info',
};

function modelUri(path: string) {
  return monacoApi.Uri.parse(`inmemory://forge/${path}`);
}

export function CodeEditor({ path, readOnly }: { path: string; readOnly: boolean }) {
  const content = useFileStore((s) => s.files[path]);
  const writeFile = useFileStore((s) => s.writeFile);
  const files = useFileStore((s) => s.files);
  const setCursor = useEditorStore((s) => s.setCursor);
  const setProblems = useEditorStore((s) => s.setProblems);
  const reveal = useEditorStore((s) => s.reveal);
  const consumeReveal = useEditorStore((s) => s.consumeReveal);
  const settings = useSettingsStore((s) => s.editor);
  const theme = useMonacoTheme();

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const viewStates = useRef(new Map<string, editor.ICodeEditorViewState | null>());

  /** Keep sibling models in sync so cross-file IntelliSense resolves. */
  const syncModels = useCallback((all: Record<string, string>) => {
    for (const [filePath, text] of Object.entries(all)) {
      const language = monacoLanguage(filePath);
      if (language === 'plaintext') continue;
      const uri = modelUri(filePath);
      const existing = monacoApi.editor.getModel(uri);
      if (!existing) monacoApi.editor.createModel(text, language, uri);
      else if (existing.getValue() !== text) existing.setValue(text);
    }
    for (const model of monacoApi.editor.getModels()) {
      const filePath = model.uri.path.replace(/^\//, '');
      if (model.uri.scheme === 'inmemory' && !(filePath in all)) model.dispose();
    }
  }, []);

  const collectProblems = useCallback(() => {
    const markers = monacoApi.editor.getModelMarkers({});
    const problems: Problem[] = markers
      .filter((marker) => marker.resource.scheme === 'inmemory')
      .map((marker) => ({
        id: uid('problem'),
        path: marker.resource.path.replace(/^\//, ''),
        line: marker.startLineNumber,
        column: marker.startColumn,
        endLine: marker.endLineNumber,
        endColumn: marker.endColumn,
        severity: SEVERITY[marker.severity] ?? 'info',
        message: marker.message,
        source: marker.owner ?? 'editor',
      }))
      .sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line);
    setProblems(problems);
  }, [setProblems]);

  const onMount: OnMount = (instance) => {
    editorRef.current = instance;
    syncModels(useFileStore.getState().files);

    instance.onDidChangeCursorPosition((event) => {
      setCursor(event.position.lineNumber, event.position.column);
    });

    // Mirror the selection so an assistant workflow can quote exactly what the
    // user highlighted, rather than guessing from the cursor.
    instance.onDidChangeCursorSelection(() => {
      const model = instance.getModel();
      const selection = instance.getSelection();
      useAiStore
        .getState()
        .setSelection(model && selection ? model.getValueInRange(selection) : '');
    });

    // Ctrl/Cmd+S is owned by the app shell, but the editor swallows it first.
    instance.addCommand(monacoApi.KeyMod.CtrlCmd | monacoApi.KeyCode.KeyS, () => {
      void useFileStore.getState().flush();
    });

    const disposable = monacoApi.editor.onDidChangeMarkers(() => collectProblems());
    instance.onDidDispose(() => disposable.dispose());
    collectProblems();
  };

  // Re-sync when files change outside the editor (shell, agent, VCS checkout).
  useEffect(() => {
    if (!editorRef.current) return;
    syncModels(files);
  }, [files, syncModels]);

  // Persist and restore per-file scroll and selection.
  useEffect(() => {
    const instance = editorRef.current;
    if (!instance) return;
    const states = viewStates.current;
    const state = states.get(path);
    if (state) instance.restoreViewState(state);
    instance.focus();
    return () => {
      const current = editorRef.current;
      if (current) states.set(path, current.saveViewState());
    };
  }, [path]);

  useEffect(() => {
    if (!reveal || reveal.path !== path) return;
    const instance = editorRef.current;
    if (!instance) return;
    instance.revealLineInCenter(reveal.line);
    instance.setPosition({ lineNumber: reveal.line, column: reveal.column });
    instance.focus();
    consumeReveal();
  }, [reveal, path, consumeReveal]);

  const onChange = (value: string | undefined) => {
    if (value === undefined || readOnly) return;
    writeFile(path, value);
  };

  return (
    <Editor
      key={path}
      path={path}
      height="100%"
      theme={theme}
      language={monacoLanguage(path)}
      value={content ?? ''}
      onChange={onChange}
      onMount={onMount}
      beforeMount={() => setupMonaco()}
      loading={
        <div className="flex h-full items-center justify-center">
          <Spinner />
        </div>
      }
      options={{
        readOnly,
        domReadOnly: readOnly,
        fontSize: settings.fontSize,
        fontFamily: settings.fontFamily,
        tabSize: settings.tabSize,
        wordWrap: settings.wordWrap ? 'on' : 'off',
        minimap: { enabled: settings.minimap, renderCharacters: false },
        lineNumbers: settings.lineNumbers ? 'on' : 'off',
        bracketPairColorization: { enabled: settings.bracketPairColorization },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        smoothScrolling: true,
        cursorBlinking: 'smooth',
        cursorSmoothCaretAnimation: 'on',
        renderWhitespace: 'selection',
        renderLineHighlight: 'all',
        padding: { top: 10, bottom: 40 },
        guides: { indentation: true, bracketPairs: true },
        suggestSelection: 'first',
        quickSuggestions: { other: true, comments: false, strings: true },
        parameterHints: { enabled: true },
        formatOnPaste: true,
        multiCursorModifier: 'ctrlCmd',
        stickyScroll: { enabled: true },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
      }}
    />
  );
}
