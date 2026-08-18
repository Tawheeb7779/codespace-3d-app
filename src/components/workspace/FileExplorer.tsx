import { useState } from 'react';
import { useProjectStore } from '@/stores/projectStore';
import { useEditorStore } from '@/stores/editorStore';
import { getFileLanguage } from '@/lib/utils';
import { ChevronRight, ChevronDown, File, Folder, FolderOpen, Plus, FilePlus, FolderPlus, Trash2 } from 'lucide-react';
import type { ProjectFile } from '@/types';

export function FileExplorer() {
  const activeProject = useProjectStore((s) => s.getActiveProject());
  const addFile = useProjectStore((s) => s.addFile);
  const deleteFile = useProjectStore((s) => s.deleteFile);
  const renameFile = useProjectStore((s) => s.renameFile);
  const openFile = useEditorStore((s) => s.openFile);
  const fileContents = useEditorStore((s) => s.fileContents);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);

  if (!activeProject) return null;

  const toggleExpand = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const handleFileClick = (file: ProjectFile) => {
    if (file.type === 'folder') {
      toggleExpand(file.id);
    } else {
      setSelected(file.id);
      const existingContent = fileContents[file.id];
      openFile(file.id, existingContent ?? file.content ?? '');
    }
  };

  const handleNewFile = (parentId: string | null) => {
    const name = prompt('File name:');
    if (!name) return;
    addFile(activeProject.id, {
      name,
      type: 'file',
      parentId,
      content: '',
      language: getFileLanguage(name),
    });
  };

  const handleNewFolder = (parentId: string | null) => {
    const name = prompt('Folder name:');
    if (!name) return;
    const folderId = addFile(activeProject.id, {
      name,
      type: 'folder',
      parentId,
      children: [],
    });
    setExpanded((prev) => new Set(prev).add(folderId));
  };

  const handleDelete = (fileId: string) => {
    if (confirm('Delete this item?')) {
      deleteFile(activeProject.id, fileId);
    }
  };

  const handleRename = (fileId: string, currentName: string) => {
    const name = prompt('New name:', currentName);
    if (name && name !== currentName) {
      renameFile(activeProject.id, fileId, name);
    }
  };

  const renderFile = (file: ProjectFile, depth: number) => {
    const isExpanded = expanded.has(file.id);
    const isSelected = selected === file.id;
    const children = activeProject.files.filter((f) => f.parentId === file.id);

    return (
      <div key={file.id}>
        <div
          className={`group flex items-center gap-1 px-2 py-1 cursor-pointer rounded text-sm transition-colors ${
            isSelected ? 'bg-primary/10 text-primary' : 'text-on-surface-variant hover:bg-white/5 hover:text-on-surface'
          }`}
          style={{ paddingLeft: `${depth * 12 + 8}px` }}
          onClick={() => handleFileClick(file)}
          onContextMenu={(e) => {
            e.preventDefault();
            if (confirm(`Delete "${file.name}"?`)) handleDelete(file.id);
          }}
        >
          {file.type === 'folder' ? (
            <>
              {isExpanded ? <ChevronDown size={14} className="shrink-0 text-outline" /> : <ChevronRight size={14} className="shrink-0 text-outline" />}
              {isExpanded ? <FolderOpen size={14} className="shrink-0 text-secondary" /> : <Folder size={14} className="shrink-0 text-secondary" />}
            </>
          ) : (
            <>
              <span className="w-[14px] shrink-0" />
              <File size={14} className="shrink-0 text-outline" />
            </>
          )}
          <span
            className="flex-1 truncate"
            onDoubleClick={() => handleRename(file.id, file.name)}
          >
            {file.name}
          </span>
        </div>
        {file.type === 'folder' && isExpanded && children.map((child) => renderFile(child, depth + 1))}
      </div>
    );
  };

  const rootFiles = activeProject.files.filter((f) => f.parentId === null);

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-3 py-2 border-b border-outline-variant/10">
        <span className="font-label-caps text-label-caps text-on-surface-variant">Explorer</span>
        <div className="flex items-center gap-0.5">
          <button onClick={() => handleNewFile(null)} className="p-1 rounded text-outline hover:text-on-surface hover:bg-white/5 transition-colors" title="New File">
            <FilePlus size={14} />
          </button>
          <button onClick={() => handleNewFolder(null)} className="p-1 rounded text-outline hover:text-on-surface hover:bg-white/5 transition-colors" title="New Folder">
            <FolderPlus size={14} />
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto py-1">
        {rootFiles.map((file) => renderFile(file, 0))}
      </div>
    </div>
  );
}
