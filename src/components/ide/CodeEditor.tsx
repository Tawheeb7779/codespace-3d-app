import { useCallback, useEffect, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { setupMonaco, monaco as monacoApi } from '@/lib/monaco';
import { monacoLanguage } from '@/lib/languages';
import { changedPaths, hasRemovals } from '@/lib/modelSync';
import { registerAskAboutSelection, registerInlineAi } from '@/lib/inlineAi';
import { useFileStore } from '@/stores/fileStore';
import { useAiStore } from '@/stores/aiStore';
import { useEditorStore } from '@/stores/editorStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useMonacoTheme } from '@/hooks/useTheme';
import { useIsMobile } from '@/hooks/useMediaQuery';
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
  // On a phone the minimap takes about a quarter of the line width to show an
  // unreadable thumbnail of code you can already see. The setting still means
  // "show the minimap"; there is simply nowhere to put it at this size, and
  // honouring it literally would make the editor worse at the width where
  // every column counts.
  const isMobile = useIsMobile();
  const theme = useMonacoTheme();

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const viewStates = useRef(new Map<string, editor.ICodeEditorViewState | null>());

  /*
   * Keep sibling models in sync so cross-file IntelliSense resolves — but
   * reconcile only what changed.
   *
   * This runs whenever the store's file map changes, which is every keystroke —
   * the editor writes each change straight through. It used to walk every file
   * and call `getValue()` on each model to compare, so on a 900-file project a
   * single keypress materialised the text of the entire project before the
   * frame could paint. Measured on such a project: p95 keystroke-to-frame
   * 61.3ms, against 22.6ms on a small one.
   *
   * The store replaces the map object on a write but keeps the very same string
   * for every untouched file, and comparing equal references costs a pointer
   * check, so finding the one file that moved never reads a model at all.
   * `getValue()` now happens only for a file whose text genuinely differs.
   *
   * Safe because this function owns the only `model.dispose()` in the app: if a
   * path's text is unchanged since the last sync, its model is still there.
   */
  const lastSynced = useRef<Record<string, string>>({});

  const syncModels = useCallback((all: Record<string, string>) => {
    const previous = lastSynced.current;
    lastSynced.current = all;

    for (const filePath of changedPaths(previous, all)) {
      const text = all[filePath];
      const language = monacoLanguage(filePath);
      if (language === 'plaintext') continue;
      const uri = modelUri(filePath);
      const existing = monacoApi.editor.getModel(uri);
      if (!existing) monacoApi.editor.createModel(text, language, uri);
      else if (existing.getValue() !== text) existing.setValue(text);
    }

    // The sweep is only worth its walk when a file actually went away, which is
    // rare; a keystroke never removes one.
    if (!hasRemovals(previous, all)) return;

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

    // The assistant's workflows, on the code they are about. These are the
    // same workflows the panel runs; this only adds a second way in.
    const releaseInlineAi = registerInlineAi(instance);
    const releaseAsk = registerAskAboutSelection(instance);

    const disposable = monacoApi.editor.onDidChangeMarkers(() => collectProblems());
    instance.onDidDispose(() => {
      disposable.dispose();
      releaseInlineAi();
      releaseAsk();
    });
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
        minimap: { enabled: settings.minimap && !isMobile, renderCharacters: false },
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
