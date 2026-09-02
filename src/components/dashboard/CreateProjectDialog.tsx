import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Check } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { Input, Textarea } from '@/components/ui/Field';
import { Badge } from '@/components/ui/Primitives';
import { TEMPLATES } from '@/lib/templates';
import type { TemplateId } from '@/types';
import { useProjectStore } from '@/stores/projectStore';
import { toast } from '@/stores/toastStore';
import { cx, errorMessage } from '@/lib/utils';

export function CreateProjectDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const create = useProjectStore((s) => s.create);
  const [template, setTemplate] = useState<TemplateId>('react-ts');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = TEMPLATES.find((t) => t.id === template);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const project = await create({
        name: name.trim() || `${selected?.name ?? 'New'} project`,
        description,
        template,
      });
      toast.success('Project created', project.name);
      onClose();
      navigate(`/project/${project.id}`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="New project"
      description="Pick a starting point. Everything is editable afterwards."
      size="lg"
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void submit()}>
            Create project
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <fieldset>
          <legend className="panel-label mb-2">Template</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {TEMPLATES.map((item) => {
              const active = item.id === template;
              return (
                <button
                  key={item.id}
                  type="button"
                  // Without this the accessible name concatenates the title,
                  // badge and description into one long string.
                  aria-label={item.name}
                  aria-pressed={active}
                  onClick={() => setTemplate(item.id)}
                  className={cx(
                    'rounded-lg border p-3 text-left transition-colors',
                    active
                      ? 'border-accent bg-accent-soft/40'
                      : 'border-line bg-surface hover:border-line-strong',
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-base font-medium text-ink">{item.name}</span>
                    {active ? (
                      <Check className="h-3.5 w-3.5 shrink-0 text-accent" />
                    ) : (
                      <Badge>{item.tag}</Badge>
                    )}
                  </div>
                  <p className="mt-1 text-sm text-ink-muted">{item.description}</p>
                </button>
              );
            })}
          </div>
        </fieldset>

        {selected && !selected.runnable && (
          <p className="rounded border border-caution/30 bg-caution/5 p-2.5 text-sm text-ink-muted">
            <span className="font-medium text-caution">Preview unavailable for this template. </span>
            {selected.runnableNote}
          </p>
        )}

        <Input
          label="Project name"
          value={name}
          maxLength={60}
          onChange={(event) => setName(event.target.value)}
          placeholder={selected ? `${selected.name} project` : 'My project'}
        />
        <Textarea
          label="Description"
          rows={2}
          maxLength={280}
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Optional. Shown on the dashboard card."
        />

        {error && (
          <p role="alert" className="rounded border border-danger/40 bg-danger/5 p-2.5 text-sm text-danger">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
