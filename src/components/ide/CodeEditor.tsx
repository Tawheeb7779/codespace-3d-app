import { useCallback, useEffect, useRef } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import type { editor } from 'monaco-editor';
import { setupMonaco, monaco as monacoApi } from '@/lib/monaco';
import { monacoLanguage } from '@/lib/languages';
import { changedPaths, hasRemovals, minimalEdit } from '@/lib/modelSync';
import { registerAskAboutSelection, registerInlineAi } from '@/lib/inlineAi';
import { useFileStore } from '@/stores/fileStore';
import { useAiStore } from '@/stores/aiStore';
import { useEditorStore } from '@/stores/editorStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useAuthStore } from '@/stores/authStore';
import { useCollabStore } from '@/stores/collabStore';
import { supabase } from '@/lib/supabase';
import { useMonacoTheme } from '@/hooks/useTheme';
import { useIsMobile } from '@/hooks/useMediaQuery';
import { Spinner } from '@/components/ui/Primitives';
import { problemsFromMarkers, problemsSignature } from '@/lib/diagnostics';

/**
 * Monaco bound to the virtual file system.
 *
 * Every open file gets its own model keyed by an in-memory URI, which is what
 * lets TypeScript resolve imports between project files and gives each tab an
 * independent undo stack and view state.
 */

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
  const collabEnabled = useCollabStore((s) => s.enabled);
  const projectId = useFileStore((s) => s.projectId);
  const user = useAuthStore((s) => s.user);
  // Only for the file on screen: a status left over from the previous tab
  // would lock this one for a document it says nothing about.
  const bootstrapping = useCollabStore(
    (s) => s.enabled && s.path === path && s.status === 'bootstrapping',
  );

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
      if (!existing) {
        monacoApi.editor.createModel(text, language, uri);
        continue;
      }
      // Applied as an edit over the smallest changed span, not `setValue`.
      // This branch fires when something other than this editor wrote the file
      // — the AI agent, or the container terminal — and `setValue` would clear
      // the undo stack and send the cursor to the top of a file the person is
      // still reading.
      const edit = minimalEdit(existing.getValue(), text);
      if (!edit) continue;
      existing.pushEditOperations(
        null,
        [
          {
            range: monacoApi.Range.fromPositions(
              existing.getPositionAt(edit.start),
              existing.getPositionAt(edit.end),
            ),
            text: edit.text,
          },
        ],
        () => null,
      );
    }

    // The sweep is only worth its walk when a file actually went away, which is
    // rare; a keystroke never removes one.
    if (!hasRemovals(previous, all)) return;

    for (const model of monacoApi.editor.getModels()) {
      const filePath = model.uri.path.replace(/^\//, '');
      if (model.uri.scheme === 'inmemory' && !(filePath in all)) model.dispose();
    }
  }, []);

  /**
   * The problem set from Monaco's markers, published only when it changed.
   *
   * The mapping and the comparison live in `lib/diagnostics`, where they can
   * be tested without a Monaco instance — and where the reasoning about how
   * often this runs is written down. The short version: the language services
   * re-report the same diagnostics continuously while you type, and a pass
   * that found nothing new now writes nothing at all.
   */
  const lastProblems = useRef<string>('');

  const collectProblems = useCallback(() => {
    const problems = problemsFromMarkers(monacoApi.editor.getModelMarkers({}));
    const signature = problemsSignature(problems);
    if (signature === lastProblems.current) return;
    lastProblems.current = signature;
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

  /**
   * Share this file, when the person has asked to.
   *
   * Attached to the *model*, after mount, and only for the file on screen. The
   * binding is torn down on every change of file or of the switch, because a
   * live channel for a file nobody is looking at is bandwidth and a caret on
   * somebody else's screen for a person who has moved on.
   *
   * Bound edits still reach `onChange`, so the save path below is unchanged:
   * a remote edit is written to the store exactly as a local one is.
   */
  useEffect(() => {
    if (!collabEnabled || !projectId || !user || !supabase || readOnly) return;
    const instance = editorRef.current;
    const model = instance?.getModel();
    if (!instance || !model) return;

    /*
     * Loaded on demand, not with the workspace.
     *
     * Yjs and its Monaco binding are about 30kB gzipped, and shared editing is
     * off by default — so importing them eagerly would charge every
     * single-player session for a feature it never uses. `cancelled` guards the
     * gap: a person can switch file before the import resolves, and binding a
     * document to a model nobody is looking at leaves a live channel behind.
     */
    let cancelled = false;
    let handle: { destroy: () => void } | null = null;
    // Narrowed here so the closure below carries a client rather than a maybe.
    const client = supabase;

    void import('@/lib/collab/editorBinding').then(({ bindSharedDocument }) => {
      if (cancelled || instance.getModel() !== model) return;
      handle = bindSharedDocument({
        client,
        projectId,
        path,
        model,
        editors: [instance],
        identity: { userId: user.id, displayName: user.displayName || user.email },
        initialText: () => useFileStore.getState().files[path] ?? '',
      });
    });

    return () => {
      cancelled = true;
      handle?.destroy();
    };
    // `content` is deliberately absent: rebinding on every keystroke would
    // rebuild the document, and the binding is what keeps content current.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collabEnabled, projectId, path, readOnly, user?.id]);

  const onChange = (value: string | undefined) => {
    if (value === undefined || readOnly) return;
    writeFile(path, value);
  };

  return (
    /*
     * `key={path}` stays, on evidence rather than on principle.
     *
     * It looks like a mistake — it makes React unmount the editor and mount a
     * new one on every tab switch, where the `path` prop alone would swap the
     * model on the live instance. Removing it was measured in Chromium against
     * this same build: tab switch to painted 96ms before, 97ms after, and the
     * `.monaco-editor` root is replaced either way, because Monaco rebuilds
     * its own view when a model is attached. Undo across a tab switch was
     * checked too, and works in both.
     *
     * So there is no measured gain, and the key is load-bearing for mount
     * ordering the rest of this file relies on. Changing a critical subsystem
     * for a benefit that does not show up in a measurement is how a
     * performance pass makes a product worse.
     */
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
        // Read-only until the shared document has settled. Typing into one
        // that a peer is about to replace is how a first sentence disappears.
        readOnly: readOnly || bootstrapping,
        domReadOnly: readOnly || bootstrapping,
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
