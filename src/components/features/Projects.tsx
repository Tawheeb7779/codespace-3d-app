import { useState } from 'react';
import { useProjectStore } from '@/stores/projectStore';
import { useUIStore } from '@/stores/uiStore';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import { Badge } from '@/components/ui/Toast';
import { formatTimeAgo } from '@/lib/utils';
import { Plus, Box, Trash2, FileCode, Layers, Sparkles } from 'lucide-react';
import type { ProjectTemplate } from '@/types';

const templates: { id: ProjectTemplate; name: string; description: string; icon: typeof Box }[] = [
  { id: 'blank', name: 'Blank', description: 'Start from scratch', icon: FileCode },
  { id: 'html', name: 'HTML/CSS/JS', description: 'Classic web project', icon: Layers },
  { id: 'react', name: 'React', description: 'React + TypeScript', icon: FileCode },
  { id: 'threejs', name: 'Three.js', description: '3D rendering with Three.js', icon: Box },
  { id: 'react-three', name: 'React + Three.js', description: 'R3F integration', icon: Sparkles },
];

export function Projects() {
  const { projects, createProject, deleteProject, setActiveProject } = useProjectStore();
  const setView = useUIStore((s) => s.setView);
  const [showCreate, setShowCreate] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [template, setTemplate] = useState<ProjectTemplate>('blank');

  const handleCreate = () => {
    if (!name.trim()) return;
    const id = createProject(name.trim(), description.trim(), template);
    setActiveProject(id);
    setShowCreate(false);
    setName('');
    setDescription('');
    setTemplate('blank');
    setView('workspace');
  };

  return (
    <div className="flex-1 overflow-auto p-4 lg:p-6">
      <div className="max-w-[1200px] mx-auto space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="font-headline-lg text-headline-lg text-on-surface">Projects</h1>
            <p className="text-on-surface-variant text-sm mt-1">{projects.length} project(s)</p>
          </div>
          <Button variant="primary" onClick={() => setShowCreate(true)}>
            <Plus size={16} /> New Project
          </Button>
        </div>

        {projects.length === 0 ? (
          <Card className="p-12 text-center">
            <Box size={48} className="mx-auto text-outline mb-4" />
            <h3 className="font-headline-md text-lg text-on-surface mb-2">No projects yet</h3>
            <p className="text-sm text-on-surface-variant mb-6">Create your first project to start building in CodeSpace 3D.</p>
            <Button variant="primary" onClick={() => setShowCreate(true)}>
              <Plus size={16} /> Create Project
            </Button>
          </Card>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((project) => (
              <Card key={project.id} hover className="p-4 flex flex-col" onClick={() => { setActiveProject(project.id); setView('workspace'); }}>
                <div className="flex items-start justify-between mb-3">
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center">
                    <Box size={20} className="text-primary" />
                  </div>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      if (confirm(`Delete "${project.name}"?`)) deleteProject(project.id);
                    }}
                    className="p-1 rounded text-outline hover:text-error transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <h3 className="text-sm font-semibold text-on-surface mb-1">{project.name}</h3>
                <p className="text-xs text-on-surface-variant line-clamp-2 mb-3 flex-1">{project.description || 'No description'}</p>
                <div className="flex items-center justify-between">
                  <Badge color="primary">{project.template}</Badge>
                  <span className="text-[10px] text-outline font-mono">{formatTimeAgo(project.updatedAt)}</span>
                </div>
              </Card>
            ))}
          </div>
        )}
      </div>

      <Modal open={showCreate} onClose={() => setShowCreate(false)} title="Create New Project">
        <div className="space-y-4">
          <div>
            <label className="block text-xs font-label-caps text-on-surface-variant mb-1.5">Project Name</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Awesome Project"
              className="w-full bg-surface-low border border-outline-variant/20 rounded px-3 py-2 text-sm text-on-surface focus:border-primary/50 focus:outline-none"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-xs font-label-caps text-on-surface-variant mb-1.5">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What are you building?"
              rows={2}
              className="w-full bg-surface-low border border-outline-variant/20 rounded px-3 py-2 text-sm text-on-surface focus:border-primary/50 focus:outline-none resize-none"
            />
          </div>
          <div>
            <label className="block text-xs font-label-caps text-on-surface-variant mb-1.5">Template</label>
            <div className="grid grid-cols-2 gap-2">
              {templates.map((t) => {
                const Icon = t.icon;
                return (
                  <button
                    key={t.id}
                    onClick={() => setTemplate(t.id)}
                    className={`flex items-center gap-2 p-3 rounded-lg border text-left transition-all ${
                      template === t.id
                        ? 'bg-primary/10 border-primary/30 text-on-surface'
                        : 'glass-elevated border-outline-variant/10 text-on-surface-variant hover:bg-surface-high'
                    }`}
                  >
                    <Icon size={18} className={template === t.id ? 'text-primary' : 'text-outline'} />
                    <div>
                      <div className="text-xs font-semibold">{t.name}</div>
                      <div className="text-[10px] text-outline">{t.description}</div>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button variant="primary" onClick={handleCreate} disabled={!name.trim()}>
              <Plus size={16} /> Create
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
