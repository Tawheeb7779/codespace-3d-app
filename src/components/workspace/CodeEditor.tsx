import { useCallback } from 'react';
import Editor, { type OnMount } from '@monaco-editor/react';
import { useEditorStore } from '@/stores/editorStore';
import { useProjectStore } from '@/stores/projectStore';
import { getFileLanguage } from '@/lib/utils';
import { EditorTabs } from './EditorTabs';
import { FileCode } from 'lucide-react';

export function CodeEditor() {
  const activeFileId = useEditorStore((s) => s.activeFileId);
  const fileContents = useEditorStore((s) => s.fileContents);
  const updateContent = useEditorStore((s) => s.updateContent);
  const openFile = useEditorStore((s) => s.openFile);
  const activeProject = useProjectStore((s) => s.getActiveProject());

  const file = activeProject?.files.find((f) => f.id === activeFileId);
  const content = activeFileId ? fileContents[activeFileId] ?? '' : '';

  const handleMount: OnMount = useCallback((editor, monaco) => {
    monaco.editor.defineTheme('codespace-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [],
      colors: {
        'editor.background': '#090d16',
        'editor.foreground': '#dee2f1',
        'editorLineNumber.foreground': '#424754',
        'editorLineNumber.activeForeground': '#adc6ff',
        'editor.selectionBackground': '#4d8eff33',
        'editor.lineHighlightBackground': '#ffffff08',
        'editorCursor.foreground': '#adc6ff',
        'editorIndentGuide.background': '#42475440',
      },
    });
    monaco.editor.setTheme('codespace-dark');
  }, []);

  if (!activeProject) {
    return (
      <div className="flex-1 flex items-center justify-center text-on-surface-variant">
        <div className="text-center">
          <FileCode size={48} className="mx-auto mb-3 text-outline" />
          <p className="text-sm">No active project</p>
        </div>
      </div>
    );
  }

  if (!file) {
    return (
      <div className="flex-1 flex flex-col">
        <EditorTabs />
        <div className="flex-1 flex items-center justify-center text-on-surface-variant">
          <div className="text-center">
            <FileCode size={48} className="mx-auto mb-3 text-outline" />
            <p className="text-sm">Select a file to edit</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-w-0">
      <EditorTabs />
      <Editor
        height="100%"
        path={file.name}
        language={file.language ?? getFileLanguage(file.name)}
        value={content}
        onMount={handleMount}
        onChange={(value) => {
          if (activeFileId && value !== undefined) {
            updateContent(activeFileId, value);
          }
        }}
        options={{
          minimap: { enabled: true },
          fontSize: 14,
          fontFamily: 'JetBrains Mono, monospace',
          fontLigatures: true,
          lineNumbers: 'on',
          folding: true,
          automaticLayout: true,
          tabSize: 2,
          wordWrap: 'off',
          scrollBeyondLastLine: false,
          smoothScrolling: true,
          cursorBlinking: 'smooth',
          renderWhitespace: 'selection',
        }}
      />
    </div>
  );
}
