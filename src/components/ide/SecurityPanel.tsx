import { useState } from 'react';
import { AlertCircle, Package, RefreshCw, ShieldCheck, Sparkles } from 'lucide-react';
import { PanelHeader, EmptyState, Badge } from '@/components/ui/Primitives';
import { IconButton } from '@/components/ui/IconButton';
import { Button } from '@/components/ui/Button';
import { FileIcon } from '@/components/ide/FileIcon';
import { useFileStore } from '@/stores/fileStore';
import { useEditorStore } from '@/stores/editorStore';
import { useAiStore } from '@/stores/aiStore';
import { useUIStore } from '@/stores/uiStore';
import { scanProject, type Finding, type Severity } from '@/lib/security/scan';
import { basename } from '@/lib/vfs';
import { cx, formatTimeAgo } from '@/lib/utils';

/**
 * What this project's own files say about its security.
 *
 * Everything here was read out of the workspace a moment ago — a path, a line
 * and the text that produced the finding, so it can be checked rather than
 * believed. Nothing is fetched and nothing is inferred from a package name.
 *
 * The score is deliberately explained rather than displayed alone. A bare
 * number invites "we are at 92", and 92 out of what is the only question worth
 * asking: these checks are secrets, values published to the browser, ignored
 * environment files, a handful of unsafe calls and iframe sandbox flags. A
 * hundred means those found nothing, not that a project is secure — and the
 * panel says so where the number is.
 *
 * The dependency section is the honest gap. There is no advisory database here,
 * so it lists what is installed and says it has checked none of it, rather than
 * showing a green tick that means nothing.
 */

const TONE: Record<Severity, { badge: 'danger' | 'caution' | 'accent' | 'neutral'; text: string }> = {
  critical: { badge: 'danger', text: 'text-danger' },
  high: { badge: 'danger', text: 'text-danger' },
  medium: { badge: 'caution', text: 'text-caution' },
  low: { badge: 'neutral', text: 'text-ink-muted' },
};

function FindingRow({ finding }: { finding: Finding }) {
  const reveal = useEditorStore((s) => s.revealLocation);
  const send = useAiStore((s) => s.send);
  const running = useAiStore((s) => s.running);
  const setSidebarPanel = useUIStore((s) => s.setSidebarPanel);
  const [open, setOpen] = useState(false);

  /*
   * Remediation goes through the ordinary agent.
   *
   * The same `send` the assistant panel calls, so the same tool permissions and
   * the same approval prompt for a destructive change apply. The prompt carries
   * the file and line and asks for a fix — it never carries the credential,
   * which is the one thing that must not be copied anywhere else.
   */
  const askForFix = () => {
    setSidebarPanel('assistant');
    void send(
      `There is a security finding in this project.\n\n` +
        `File: ${finding.path}\nLine: ${finding.line}\nIssue: ${finding.title}\n` +
        `Why it matters: ${finding.detail}\n\n` +
        `Read that file, explain what is actually happening there, and propose the smallest safe fix. ` +
        `Do not include any credential value in your reply.`,
    );
  };

  return (
    <div className="border-b border-line">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full items-start gap-2 px-2.5 py-1.5 text-left hover:bg-surface-raised"
      >
        <AlertCircle
          aria-hidden
          className={cx('mt-0.5 h-3.5 w-3.5 shrink-0', TONE[finding.severity].text)}
        />
        <span className="min-w-0 flex-1">
          <span className="block break-words text-base text-ink">{finding.title}</span>
          <span className="mt-0.5 flex items-center gap-1.5 text-sm text-ink-faint">
            <FileIcon path={finding.path} />
            <span className="truncate">{basename(finding.path)}</span>
            <span className="shrink-0 font-mono tabular-nums">:{finding.line}</span>
          </span>
        </span>
        <Badge tone={TONE[finding.severity].badge}>{finding.severity}</Badge>
      </button>

      {open && (
        <div className="space-y-2 px-2.5 pb-2 pl-8">
          <p className="text-sm text-ink-muted">{finding.detail}</p>
          {/* Redacted where it is a credential: enough to find the line, never
              enough to use. */}
          <pre className="scrollbar-thin overflow-x-auto rounded border border-line bg-surface-sunken p-1.5 font-mono text-sm text-ink-muted">
            {finding.evidence}
          </pre>
          <div className="flex flex-wrap gap-1.5">
            <Button size="xs" onClick={() => reveal(finding.path, finding.line, 1)}>
              Go to it
            </Button>
            <Button
              size="xs"
              disabled={running}
              leading={<Sparkles className="h-3 w-3" />}
              onClick={askForFix}
            >
              Ask the assistant
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SecurityPanel() {
  const [showDependencies, setShowDependencies] = useState(false);

  /*
   * Scanned on demand, over a snapshot.
   *
   * The scan walks every file in the project. Deriving it from the file store
   * would re-run it on every keystroke — the store replaces its map on each
   * write — to keep a number current that nobody is reading while they type.
   * So the files are read when a scan is asked for, and the result is held
   * until the next one.
   */
  const [report, setReport] = useState(() => scanProject(useFileStore.getState().files));
  const [scannedAt, setScannedAt] = useState(() => Date.now());
  const rescan = () => {
    setReport(scanProject(useFileStore.getState().files));
    setScannedAt(Date.now());
  };

  /*
   * Written out rather than interpolated.
   *
   * Tailwind generates the classes it can see in the source, so a template
   * literal like `text-${tone}` produces a class that does not exist and a
   * score with no colour at all.
   */
  const tone: 'danger' | 'caution' | 'neutral' | 'positive' =
    report.counts.critical > 0
      ? 'danger'
      : report.counts.high > 0
        ? 'caution'
        : report.findings.length > 0
          ? 'neutral'
          : 'positive';
  const scoreColour = {
    danger: 'text-danger',
    caution: 'text-caution',
    neutral: 'text-ink',
    positive: 'text-positive',
  }[tone];

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader
        title="Security"
        actions={
          <IconButton
            label="Scan again"
            size="xs"
            icon={<RefreshCw className="h-3.5 w-3.5" />}
            onClick={rescan}
          />
        }
      />

      <div className="shrink-0 border-b border-line px-2.5 py-2">
        <div className="flex items-baseline gap-2">
          <span className={cx('text-2xl font-medium tabular-nums', scoreColour)}>
            {report.score}
          </span>
          <Badge tone={tone === 'positive' ? 'positive' : tone === 'danger' ? 'danger' : 'caution'}>
            {report.findings.length === 0
              ? 'nothing found'
              : `${report.findings.length} finding${report.findings.length === 1 ? '' : 's'}`}
          </Badge>
        </div>
        {/* What the number is, said where the number is. */}
        <p className="mt-1 text-sm text-ink-faint">
          <span>
            Out of 100, from {report.scannedFiles} files checked for secrets, values published to the
            browser, unignored environment files, unsafe calls and iframe sandboxes. A hundred means
            those checks found nothing — not that the project is secure.
          </span>
        </p>
        <p className="mt-1 text-sm text-ink-faint">
          {/* It is a snapshot, so when it was taken is part of the reading. */}
          <span>Scanned {formatTimeAgo(scannedAt)}.</span>
        </p>
        {report.findings.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {(['critical', 'high', 'medium', 'low'] as const)
              .filter((severity) => report.counts[severity] > 0)
              .map((severity) => (
                <Badge key={severity} tone={TONE[severity].badge}>
                  {report.counts[severity]} {severity}
                </Badge>
              ))}
          </div>
        )}
      </div>

      <div className="scrollbar-thin min-h-0 flex-1 overflow-y-auto">
        {report.findings.length === 0 ? (
          <EmptyState
            icon={<ShieldCheck className="h-4 w-4" />}
            title="These checks found nothing"
            description="Secrets, browser-published values, environment files, unsafe calls and sandbox flags all came back clean."
          />
        ) : (
          report.findings.map((finding) => <FindingRow key={finding.id} finding={finding} />)
        )}

        <section className="border-t border-line">
          <button
            type="button"
            aria-expanded={showDependencies}
            onClick={() => setShowDependencies(!showDependencies)}
            className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-surface-raised"
          >
            <Package aria-hidden className="h-3 w-3 shrink-0 text-ink-faint" />
            <span className="panel-label flex-1">Dependencies</span>
            <span className="text-sm tabular-nums text-ink-faint">
              {report.dependencies.dependencies.length}
            </span>
          </button>

          {showDependencies && (
            <div className="pb-2">
              {/* The gap, stated plainly. A green tick here would mean nothing
                  and would be read as meaning everything. */}
              {report.dependencies.advisoriesUnavailable && (
                <p className="mx-2.5 mb-1.5 rounded border border-caution/40 bg-caution/5 p-1.5 text-sm text-caution">
                  <span>{report.dependencies.advisoriesUnavailable}</span>
                </p>
              )}
              {report.dependencies.dependencies.map((entry) => (
                <p
                  key={`${entry.name}@${entry.range}`}
                  className="flex items-baseline gap-2 px-2.5 py-0.5 text-sm"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-ink-muted">
                    {entry.name}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums text-ink-faint">
                    {entry.range}
                  </span>
                  {entry.dev && <span className="shrink-0 text-xs text-ink-faint">dev</span>}
                </p>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
