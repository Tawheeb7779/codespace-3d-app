import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';

/**
 * Monaco is bundled with the app rather than pulled from a CDN: the IDE must
 * work offline and behind a strict content policy. Language services run in
 * dedicated workers, which is what keeps typing responsive while TypeScript
 * type-checks in the background.
 */

let configured = false;

export function setupMonaco(): typeof monaco {
  if (configured) return monaco;
  configured = true;

  self.MonacoEnvironment = {
    getWorker(_workerId: string, label: string) {
      switch (label) {
        case 'json':
          return new jsonWorker();
        case 'css':
        case 'scss':
        case 'less':
          return new cssWorker();
        case 'html':
        case 'handlebars':
        case 'razor':
          return new htmlWorker();
        case 'typescript':
        case 'javascript':
          return new tsWorker();
        default:
          return new editorWorker();
      }
    },
  };

  /*
   * The editor's own colours, matched to the interface's.
   *
   * `editor.background` is the sunken surface rather than the panel surface:
   * code sits under the frame, and that one step of separation is what stops
   * the editor from dissolving into the sidebar. The syntax hues are held
   * apart from the interface accent on purpose — a keyword that shares a colour
   * with the focus ring makes both harder to find.
   */
  monaco.editor.defineTheme('forge-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6d7581', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c39ae0' },
      { token: 'string', foreground: '8fca7a' },
      { token: 'number', foreground: 'e0a76a' },
      { token: 'type', foreground: '6fc6dd' },
      { token: 'function', foreground: '7fb2e8' },
      { token: 'variable', foreground: 'e3e7ed' },
      { token: 'tag', foreground: 'e88b93' },
      { token: 'attribute.name', foreground: 'c0a2dd' },
    ],
    colors: {
      'editor.background': '#070909',
      'editor.foreground': '#e3e7ed',
      'editorLineNumber.foreground': '#3a424e',
      'editorLineNumber.activeForeground': '#98a0ac',
      'editor.selectionBackground': '#12384a',
      'editor.lineHighlightBackground': '#111418',
      'editorCursor.foreground': '#38b0d6',
      'editorIndentGuide.background1': '#1b1f25',
      'editorIndentGuide.activeBackground1': '#2c333c',
      'editorGutter.background': '#070909',
      'editorWidget.background': '#1c2127',
      'editorWidget.border': '#242a32',
      'editorSuggestWidget.background': '#1c2127',
      'editorSuggestWidget.selectedBackground': '#0d2a36',
      'editorHoverWidget.background': '#1c2127',
      'scrollbarSlider.background': '#39424e',
      'minimap.background': '#070909',
    },
  });

  monaco.editor.defineTheme('forge-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '74808f', fontStyle: 'italic' },
      { token: 'keyword', foreground: '7c2d9e' },
      { token: 'string', foreground: '0d7742' },
      { token: 'number', foreground: '8d5c06' },
      { token: 'type', foreground: '0d749c' },
      { token: 'function', foreground: '1d5fb8' },
      { token: 'tag', foreground: 'ba2828' },
      { token: 'attribute.name', foreground: '7c2d9e' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#15191f',
      'editorLineNumber.foreground': '#b4bbc5',
      'editorLineNumber.activeForeground': '#555c67',
      'editor.selectionBackground': '#dbf0f8',
      'editor.lineHighlightBackground': '#f6f7f9',
      'editorCursor.foreground': '#0d749c',
      'editorIndentGuide.background1': '#e7e9ee',
      'editorIndentGuide.activeBackground1': '#c9ced7',
      'editorWidget.background': '#ffffff',
      'editorWidget.border': '#dfe2e8',
      'editorSuggestWidget.background': '#ffffff',
      'editorSuggestWidget.selectedBackground': '#dbf0f8',
    },
  });

  const compilerOptions: monaco.languages.typescript.CompilerOptions = {
    target: monaco.languages.typescript.ScriptTarget.ES2020,
    module: monaco.languages.typescript.ModuleKind.ESNext,
    moduleResolution: monaco.languages.typescript.ModuleResolutionKind.NodeJs,
    jsx: monaco.languages.typescript.JsxEmit.ReactJSX,
    allowJs: true,
    allowNonTsExtensions: true,
    esModuleInterop: true,
    strict: true,
    skipLibCheck: true,
    // Packages resolve at preview time through esm.sh; without types on hand,
    // unresolved bare imports would otherwise flood the Problems panel.
    noResolve: false,
  };
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
  monaco.languages.typescript.javascriptDefaults.setCompilerOptions(compilerOptions);

  const diagnosticsOptions = {
    noSemanticValidation: false,
    noSyntaxValidation: false,
    // 2307: "cannot find module" for bare imports we resolve from a CDN.
    // 2792: module resolution suggestion that does not apply here.
    diagnosticCodesToIgnore: [2307, 2792, 7016],
  };
  monaco.languages.typescript.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions);
  monaco.languages.typescript.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions);
  monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
  monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);

  // Must run before @monaco-editor/react calls loader.init(), which it does on
  // the first <Editor> mount. Configuring it later leaves the loader pointed at
  // its default CDN, and the editor fails to appear on an offline or
  // restricted network.
  loader.config({ monaco });
  return monaco;
}

// Importing this module is what guarantees the ordering above: every component
// that renders <Editor> imports it, and module evaluation happens first.
setupMonaco();

export type Monaco = typeof monaco;
export { monaco };
