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

  monaco.editor.defineTheme('forge-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '5c6780', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'c792ea' },
      { token: 'string', foreground: '9ece6a' },
      { token: 'number', foreground: 'ff9e64' },
      { token: 'type', foreground: '7dcfff' },
      { token: 'function', foreground: '82aaff' },
      { token: 'variable', foreground: 'e2e8f5' },
      { token: 'tag', foreground: 'f7768e' },
      { token: 'attribute.name', foreground: 'bb9af7' },
    ],
    colors: {
      'editor.background': '#0e121a',
      'editor.foreground': '#e2e8f5',
      'editorLineNumber.foreground': '#3b465c',
      'editorLineNumber.activeForeground': '#8a96b0',
      'editor.selectionBackground': '#243a6a',
      'editor.lineHighlightBackground': '#141926',
      'editorCursor.foreground': '#608fff',
      'editorIndentGuide.background1': '#1d2431',
      'editorIndentGuide.activeBackground1': '#2f3a4d',
      'editorGutter.background': '#0e121a',
      'editorWidget.background': '#181e2a',
      'editorWidget.border': '#212938',
      'editorSuggestWidget.background': '#181e2a',
      'editorSuggestWidget.selectedBackground': '#1a284a',
      'editorHoverWidget.background': '#181e2a',
      'scrollbarSlider.background': '#2b3448',
      'minimap.background': '#0b0f17',
    },
  });

  monaco.editor.defineTheme('forge-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '7a839a', fontStyle: 'italic' },
      { token: 'keyword', foreground: '8c2fbf' },
      { token: 'string', foreground: '18794e' },
      { token: 'number', foreground: 'b45309' },
      { token: 'type', foreground: '0b6f9d' },
      { token: 'function', foreground: '2a5be0' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#161b26',
      'editorLineNumber.foreground': '#b3bacb',
      'editor.lineHighlightBackground': '#f4f6fb',
      'editorCursor.foreground': '#2a5be0',
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
