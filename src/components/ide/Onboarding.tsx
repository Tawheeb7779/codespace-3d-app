import { useEffect, useState } from 'react';
import { Bot, FolderOpen, GitBranch, Play, Search, Settings, SquareTerminal } from 'lucide-react';
import { Modal } from '@/components/ui/Modal';
import { Button } from '@/components/ui/Button';
import { useSettingsStore } from '@/stores/settingsStore';
import { formatChord } from '@/hooks/useKeyboardShortcuts';

/**
 * First-run orientation.
 *
 * Six lines and a shortcut each: enough to find the parts of the IDE that are
 * not where a newcomer would guess, and nothing else. It is skippable, it
 * appears once, and completion is remembered in the same persisted settings
 * everything else uses — so clearing site data honestly resets it rather than
 * leaving a user unable to see it again.
 */

interface Step {
  icon: typeof Play;
  title: string;
  body: string;
  binding?: string;
}

const STEPS: Step[] = [
  {
    icon: FolderOpen,
    title: 'Your files live in the explorer',
    body: 'Create, rename and move files there. Everything is stored per project, in your browser.',
    binding: 'quickOpen',
  },
  {
    icon: Play,
    title: 'Run builds the project in your browser',
    body: 'There is no server: esbuild compiles the project and the preview runs it in a sandbox.',
    binding: 'run',
  },
  {
    icon: SquareTerminal,
    title: 'The terminal is real, but virtual',
    body: 'Commands act on this project’s files. Nothing reaches a host machine, and unknown commands are refused rather than faked.',
    binding: 'toggleTerminal',
  },
  {
    icon: GitBranch,
    title: 'Source control is built in',
    body: 'Commit, branch and diff locally, then connect a GitHub repository to push and pull for real.',
    binding: 'sourceControl',
  },
  {
    icon: Bot,
    title: 'The assistant edits your actual files',
    body: 'Connect your own model provider. It reads and writes through tools you can see, asks before anything destructive, and verifies with a real build.',
    binding: 'assistant',
  },
  {
    icon: Search,
    title: 'Everything else is in the command palette',
    body: 'Settings, search, git actions and layout all have commands. Start there when you cannot find something.',
    binding: 'commandPalette',
  },
];

export function Onboarding() {
  const seen = useSettingsStore((s) => s.workspace.onboarded);
  const setWorkspace = useSettingsStore((s) => s.setWorkspace);
  const keybindings = useSettingsStore((s) => s.keybindings);
  const [open, setOpen] = useState(false);

  // Opened from an effect rather than rendered directly on `!seen`, so
  // dismissing it cannot race the persisted write and flash it back.
  useEffect(() => {
    if (!seen) setOpen(true);
  }, [seen]);

  const dismiss = () => {
    setOpen(false);
    setWorkspace({ onboarded: true });
  };

  const chord = (id?: string) =>
    id ? (keybindings.find((binding) => binding.id === id)?.keys ?? '') : '';

  return (
    <Modal
      open={open}
      onClose={dismiss}
      title="Welcome to Forge"
      description="Six things worth knowing. You can reopen this from settings."
      size="lg"
      footer={
        <>
          <Button onClick={dismiss}>Skip</Button>
          <Button variant="primary" onClick={dismiss}>
            Start building
          </Button>
        </>
      }
    >
      <ul className="space-y-3">
        {STEPS.map((step) => {
          const keys = chord(step.binding);
          return (
            <li key={step.title} className="flex gap-3">
              <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded bg-surface-raised text-ink-muted">
                <step.icon aria-hidden className="h-3.5 w-3.5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="flex items-baseline gap-2 text-base text-ink">
                  {step.title}
                  {keys && (
                    <span className="shrink-0 font-mono text-sm text-ink-faint">
                      {formatChord(keys)}
                    </span>
                  )}
                </p>
                <p className="text-sm text-ink-muted">{step.body}</p>
              </div>
            </li>
          );
        })}
      </ul>

      <p className="mt-4 flex items-center gap-1.5 text-sm text-ink-faint">
        <Settings aria-hidden className="h-3 w-3 shrink-0" />
        Every shortcut here can be rebound in Settings → Keyboard.
      </p>
    </Modal>
  );
}
