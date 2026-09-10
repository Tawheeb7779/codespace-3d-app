import { useEffect, useState } from 'react';
import { Crosshair, FileCode2, MousePointerSquareDashed } from 'lucide-react';
import { PanelHeader, EmptyState, Badge } from '@/components/ui/Primitives';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { useUIBuilderStore } from '@/stores/uiBuilderStore';
import { useEditorStore } from '@/stores/editorStore';
import { usePreviewStore } from '@/stores/previewStore';
import { useUIStore } from '@/stores/uiStore';
import type { Candidate, Confidence } from '@/lib/uibuilder/locate';
import { cx } from '@/lib/utils';

/**
 * Picking something in the preview and changing the code that made it.
 *
 * There is no separate design model here. An edit is a write to the project's
 * own source, and the preview rebuilds from that source the way it always does
 * — so what you see after a change is the code running, not a mock-up of it.
 *
 * The link between an element and a line is the honest weak point: the preview
 * runs a bundle inside a sandbox with no source map back, so the line is found
 * by searching the source for what the element shows. That is a guess, it is
 * labelled as a guess, an ambiguous one is left for the reader to resolve, and
 * an edit whose line has moved is refused rather than written somewhere close.
 */

const CONFIDENCE: Record<Confidence, { label: string; tone: 'positive' | 'caution' | 'neutral' }> = {
  exact: { label: 'matched by id', tone: 'positive' },
  likely: { label: 'likely match', tone: 'neutral' },
  weak: { label: 'weak match', tone: 'caution' },
};

function CandidateRow({
  candidate,
  active,
  onPick,
}: {
  candidate: Candidate;
  active: boolean;
  onPick: () => void;
}) {
  const reveal = useEditorStore((s) => s.revealLocation);
  const badge = CONFIDENCE[candidate.confidence];

  return (
    <div
      className={cx(
        'rounded-md border px-2 py-1.5 text-xs transition-colors',
        active ? 'border-accent bg-accent-soft/20' : 'border-line hover:bg-surface-raised',
      )}
    >
      <button type="button" onClick={onPick} className="w-full text-left">
        <div className="flex items-center gap-1.5">
          <FileCode2 className="h-3.5 w-3.5 shrink-0 text-ink-faint" />
          <span className="truncate font-mono text-ink">{candidate.path}</span>
          <span className="tabular-nums text-ink-faint">:{candidate.line}</span>
          <Badge tone={badge.tone} className="ml-auto shrink-0">
            {badge.label}
          </Badge>
        </div>
        <pre className="mt-1 overflow-x-auto whitespace-pre-wrap break-all font-mono text-2xs text-ink-muted">
          {candidate.source.trim().slice(0, 200)}
        </pre>
      </button>
      <button
        type="button"
        className="mt-1 text-2xs text-accent hover:underline tap-target"
        onClick={() => reveal(candidate.path, candidate.line)}
      >
        Open in editor
      </button>
    </div>
  );
}

export function UIBuilderPanel() {
  const {
    inspecting,
    selection,
    located,
    chosen,
    applied,
    problem,
    setInspecting,
    choose,
    editText,
    editClasses,
    reset,
  } = useUIBuilderStore();
  const previewStatus = usePreviewStore((s) => s.status);
  const togglePreview = useUIStore((s) => s.togglePreview);

  const [text, setText] = useState('');
  const [classes, setClasses] = useState('');

  // The fields follow the selection: editing one element and then picking
  // another must not leave the previous element's text sitting in the box.
  useEffect(() => {
    setText(selection?.text ?? '');
    setClasses(selection?.classes.join(' ') ?? '');
  }, [selection]);

  const running = previewStatus === 'running';

  return (
    <div className="flex h-full flex-col">
      <PanelHeader title="UI builder" />

      <div className="border-b border-line px-3 py-2">
        <Button
          variant={inspecting ? 'primary' : 'ghost'}
          size="sm"
          className="w-full"
          disabled={!running}
          onClick={() => {
            togglePreview(true);
            setInspecting(!inspecting);
          }}
        >
          <Crosshair className="h-3.5 w-3.5" />
          <span>{inspecting ? 'Stop picking' : 'Pick an element'}</span>
        </Button>
        <p className="mt-1.5 text-2xs leading-relaxed text-ink-faint">
          {running ? (
            <span>
              Click anything in the preview. Its own click handlers are suppressed while picking.
            </span>
          ) : (
            <span>Run the preview first — there is nothing to pick from until it is running.</span>
          )}
        </p>
      </div>

      <div className="flex-1 overflow-y-auto">
        {!selection ? (
          <EmptyState
            icon={<MousePointerSquareDashed className="h-4 w-4" />}
            title="Nothing selected"
            description="Pick an element in the preview to find the line of source that made it."
          />
        ) : (
          <div className="space-y-3 p-3">
            <section>
              <h3 className="text-2xs uppercase tracking-wide text-ink-faint">Selected</h3>
              <p className="mt-1 break-all font-mono text-xs text-ink">{selection.path}</p>
              {selection.classes.length > 0 && (
                <p className="mt-1 break-all font-mono text-2xs text-ink-muted">
                  {selection.classes.join(' ')}
                </p>
              )}
            </section>

            <section>
              <h3 className="text-2xs uppercase tracking-wide text-ink-faint">
                Where this came from
              </h3>
              {located?.note && (
                <p className="mt-1 text-2xs leading-relaxed text-caution">{located.note}</p>
              )}
              <div className="mt-1.5 space-y-1.5">
                {located?.candidates.map((candidate) => (
                  <CandidateRow
                    key={`${candidate.path}:${candidate.line}`}
                    candidate={candidate}
                    active={chosen?.path === candidate.path && chosen?.line === candidate.line}
                    onPick={() => choose(candidate)}
                  />
                ))}
              </div>
            </section>

            {chosen && (
              <section className="space-y-2">
                <h3 className="text-2xs uppercase tracking-wide text-ink-faint">Edit the source</h3>

                {selection.text ? (
                  <div className="space-y-1">
                    <Input
                      label="Text"
                      value={text}
                      onChange={(event) => setText(event.target.value)}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={!text.trim() || text === selection.text}
                      onClick={() => editText(text)}
                    >
                      Write text to source
                    </Button>
                  </div>
                ) : (
                  <p className="text-2xs leading-relaxed text-ink-faint">
                    This element has no text of its own, so there is no literal in the source to
                    replace.
                  </p>
                )}

                <div className="space-y-1">
                  <Input
                    label="Classes"
                    value={classes}
                    onChange={(event) => setClasses(event.target.value)}
                  />
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={classes === selection.classes.join(' ')}
                    onClick={() => editClasses(classes)}
                  >
                    Write classes to source
                  </Button>
                </div>

                {applied && <p className="text-2xs leading-relaxed text-positive">{applied}</p>}
                {problem && <p className="text-2xs leading-relaxed text-danger">{problem}</p>}
              </section>
            )}

            <section className="border-t border-line pt-2">
              <h3 className="text-2xs uppercase tracking-wide text-ink-faint">What this cannot do</h3>
              <p className="mt-1 text-2xs leading-relaxed text-ink-muted">
                The preview is sandboxed without same-origin access and runs a bundle, so there is
                no source map from an element back to a line. Everything above is found by searching
                your source for the element’s id, classes and text — an element built from a
                variable or a prop has no literal to find, and this will say so rather than guess.
                Only text and classes are editable here; anything structural is an edit in the
                editor.
              </p>
              <button
                type="button"
                className="mt-2 text-2xs text-accent hover:underline tap-target"
                onClick={reset}
              >
                Clear selection
              </button>
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
