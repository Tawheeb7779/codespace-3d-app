import { Suspense, lazy } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Boxes,
  Braces,
  Cpu,
  FileCode2,
  GitBranch,
  Github,
  Globe,
  Hammer,
  KeyRound,
  Layers,
  Lock,
  Search,
  ShieldCheck,
  Sparkles,
  SquareTerminal,
  Users,
  Zap,
} from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge } from '@/components/ui/Primitives';

import { isSupabaseConfigured } from '@/lib/supabase';
import { useAuthStore } from '@/stores/authStore';

// Monaco is ~3 MB. Keeping the demo editor behind a lazy boundary keeps it out
// of the landing page's initial chunk; the component itself waits for the
// section to scroll into view before mounting.
const LandingEditor = lazy(() =>
  import('@/components/landing/LandingEditor').then((m) => ({ default: m.LandingEditor })),
);

const FEATURES = [
  {
    icon: FileCode2,
    title: 'Monaco, wired properly',
    body: 'The editor from VS Code with language workers, IntelliSense, folding, multi-cursor, go-to-symbol and format-on-save. Twenty-plus languages out of the box.',
  },
  {
    icon: Zap,
    title: 'Builds that actually run',
    body: 'esbuild compiled to WebAssembly bundles your real source in the browser. Bare imports resolve through an import map, so a dependency you add is a dependency the preview loads.',
  },
  {
    icon: SquareTerminal,
    title: 'A shell over your workspace',
    body: 'ls, grep, mv, npm, git and build all operate on your files for real. Nothing is mimed — an unimplemented command says so.',
  },
  {
    icon: GitBranch,
    title: 'Version control built in',
    body: 'Staging, commits, branches, three-way merge and a line-level diff viewer, stored with the project and available offline.',
  },
  {
    icon: Search,
    title: 'Project-wide search',
    body: 'Regex, whole word, include and exclude globs, replace across files, and previews with the match highlighted in place.',
  },
  {
    icon: ShieldCheck,
    title: 'Security as a feature',
    body: 'Row level security on every table, path traversal blocked at a single choke point, previews in an opaque sandbox origin, and no secrets in the client bundle.',
  },
];

const TECH = [
  { name: 'React 18', detail: 'UI runtime' },
  { name: 'TypeScript', detail: 'strict mode' },
  { name: 'Vite 7', detail: 'dev + build' },
  { name: 'Monaco', detail: 'editor core' },
  { name: 'esbuild-wasm', detail: 'in-browser bundler' },
  { name: 'xterm.js', detail: 'terminal' },
  { name: 'Zustand', detail: 'state slices' },
  { name: 'Tailwind', detail: 'design tokens' },
  { name: 'Supabase', detail: 'auth + Postgres' },
];

function SectionHeading({
  eyebrow,
  title,
  body,
}: {
  eyebrow: string;
  title: string;
  body?: string;
}) {
  return (
    <div className="mx-auto max-w-2xl text-center">
      <p className="panel-label text-accent">{eyebrow}</p>
      <h2 className="mt-3 text-2xl font-semibold text-ink sm:text-3xl">{title}</h2>
      {body && <p className="mt-3 text-md text-ink-muted">{body}</p>}
    </div>
  );
}

export default function LandingPage() {
  const status = useAuthStore((s) => s.status);
  const signedIn = status === 'authenticated';

  return (
    <div className="h-full overflow-y-auto overflow-x-hidden bg-canvas">
      <header className="sticky top-0 z-40 border-b border-line bg-canvas/85 backdrop-blur">
        <nav className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-6">
          <Link to="/" className="flex items-center gap-2 text-ink" aria-label="Forge IDE home">
            <span className="flex h-6 w-6 items-center justify-center rounded bg-accent text-accent-ink">
              <Hammer className="h-3.5 w-3.5" />
            </span>
            <span className="text-md font-semibold tracking-tight">Forge</span>
            <Badge tone="neutral" className="hidden sm:inline-flex">
              IDE
            </Badge>
          </Link>

          <div className="hidden items-center gap-6 text-base text-ink-muted md:flex">
            <a href="#features" className="transition-colors hover:text-ink">
              Features
            </a>
            <a href="#editor" className="transition-colors hover:text-ink">
              Editor
            </a>
            <a href="#assistant" className="transition-colors hover:text-ink">
              Assistant
            </a>
            <a href="#collaboration" className="transition-colors hover:text-ink">
              Collaboration
            </a>
            <a href="#stack" className="transition-colors hover:text-ink">
              Stack
            </a>
          </div>

          <div className="flex items-center gap-2">
            {signedIn ? (
              <Link to="/dashboard">
                <Button variant="primary" size="sm" trailing={<ArrowRight className="h-3.5 w-3.5" />}>
                  Open dashboard
                </Button>
              </Link>
            ) : (
              <>
                <Link to="/signin" className="hidden sm:block">
                  <Button variant="ghost" size="sm">
                    Sign in
                  </Button>
                </Link>
                <Link to="/signup">
                  <Button variant="primary" size="sm">
                    Start building
                  </Button>
                </Link>
              </>
            )}
          </div>
        </nav>
      </header>

      <main>
        {/* Hero */}
        <section className="relative overflow-hidden border-b border-line">
          <div aria-hidden className="pointer-events-none absolute inset-0 grid-backdrop" />
          <div className="relative mx-auto max-w-6xl px-4 pb-16 pt-20 sm:px-6 sm:pb-20 sm:pt-28">
            <div className="mx-auto max-w-3xl text-center">
              <Badge tone="accent">
                <Cpu className="h-3 w-3" /> Runs entirely in your browser
              </Badge>
              <h1 className="mt-5 text-3xl font-semibold tracking-tight text-ink sm:text-5xl">
                A real IDE that opens in a tab
              </h1>
              <p className="mx-auto mt-5 max-w-2xl text-lg text-ink-muted">
                Forge gives you the editor, terminal, bundler, version control and preview of a
                local setup, with nothing to install. Every panel does the thing it says it does.
              </p>
              <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
                <Link to={signedIn ? '/dashboard' : '/signup'}>
                  <Button variant="primary" size="lg" trailing={<ArrowRight className="h-4 w-4" />}>
                    {signedIn ? 'Go to your projects' : 'Create your first project'}
                  </Button>
                </Link>
                <a href="#editor">
                  <Button size="lg" variant="outline">
                    Try the editor below
                  </Button>
                </a>
              </div>
              {!isSupabaseConfigured && (
                <p className="mt-5 text-sm text-ink-faint">
                  This deployment has no Supabase credentials, so it runs in Local Development Mode.
                  Projects are stored in this browser.
                </p>
              )}
            </div>

            <dl className="mx-auto mt-14 grid max-w-3xl grid-cols-2 gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-4">
              {[
                ['20+', 'languages'],
                ['0', 'installs'],
                ['1', 'sandboxed preview origin'],
                ['100%', 'client-side builds'],
              ].map(([value, label]) => (
                <div key={label} className="bg-surface px-4 py-5 text-center">
                  <dt className="text-xl font-semibold text-ink">{value}</dt>
                  <dd className="mt-1 text-sm text-ink-faint">{label}</dd>
                </div>
              ))}
            </dl>
          </div>
        </section>

        {/* What it is */}
        <section className="border-b border-line py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <SectionHeading
              eyebrow="What you get"
              title="The full loop, not a code viewer"
              body="Write, build, run, inspect, commit. Forge closes the loop in the browser instead of stopping at syntax highlighting."
            />
            <div className="mt-12 grid gap-4 md:grid-cols-3">
              {[
                {
                  icon: Braces,
                  step: '01',
                  title: 'Write',
                  body: 'Monaco with real language services, tabs, breadcrumbs, split view, a command palette and project-wide search and replace.',
                },
                {
                  icon: Boxes,
                  step: '02',
                  title: 'Build',
                  body: 'esbuild-wasm compiles your source. Errors land in the Problems panel with file, line and column, and clicking one jumps to it.',
                },
                {
                  icon: Globe,
                  step: '03',
                  title: 'Run',
                  body: 'The result renders in a sandboxed iframe with console output piped back, device presets and one-click reload.',
                },
              ].map((item) => (
                <article
                  key={item.step}
                  className="rounded-lg border border-line bg-surface p-5 transition-colors hover:border-line-strong"
                >
                  <div className="flex items-center justify-between">
                    <span className="flex h-8 w-8 items-center justify-center rounded border border-line bg-surface-raised text-accent">
                      <item.icon className="h-4 w-4" />
                    </span>
                    <span className="font-mono text-xs text-ink-faint">{item.step}</span>
                  </div>
                  <h3 className="mt-4 text-md font-semibold text-ink">{item.title}</h3>
                  <p className="mt-2 text-base text-ink-muted">{item.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Feature grid */}
        <section id="features" className="border-b border-line py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <SectionHeading
              eyebrow="Capabilities"
              title="Built like a tool, not a demo"
              body="Each of these is wired to real behaviour. Where a browser genuinely cannot do something, Forge says so instead of faking it."
            />
            <div className="mt-12 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-2 lg:grid-cols-3">
              {FEATURES.map((feature) => (
                <article key={feature.title} className="bg-surface p-5">
                  <feature.icon className="h-4 w-4 text-accent" />
                  <h3 className="mt-3 text-md font-semibold text-ink">{feature.title}</h3>
                  <p className="mt-2 text-base text-ink-muted">{feature.body}</p>
                </article>
              ))}
            </div>
          </div>
        </section>

        {/* Interactive editor */}
        <section id="editor" className="border-b border-line py-20">
          <div className="mx-auto max-w-5xl px-4 sm:px-6">
            <SectionHeading
              eyebrow="Try it"
              title="This is the editor, running now"
              body="Not a screenshot and not a highlighted code block. The same Monaco instance the workspace uses, with the same theme and settings."
            />
            <div className="mt-10">
              <Suspense
                fallback={
                  <div className="flex h-[340px] items-center justify-center rounded-xl border border-line bg-surface text-sm text-ink-faint sm:h-[420px]">
                    Loading the editor…
                  </div>
                }
              >
                <LandingEditor />
              </Suspense>
            </div>
          </div>
        </section>

        {/* AI */}
        <section id="assistant" className="border-b border-line py-20">
          <div className="mx-auto grid max-w-6xl items-center gap-12 px-4 sm:px-6 lg:grid-cols-2">
            <div>
              <p className="panel-label text-accent">Coding assistant</p>
              <h2 className="mt-3 text-2xl font-semibold text-ink sm:text-3xl">
                An agent that shows its work
              </h2>
              <p className="mt-4 text-md text-ink-muted">
                Connect your own model provider and the assistant works through real tools:
                reading files, searching, editing, running shell commands. Every call is listed as
                it happens, with the actual result. Nothing is narrated that did not run.
              </p>
              <ul className="mt-6 space-y-2.5">
                {[
                  'Nine tools covering read, write, search, structure and shell',
                  'Write tools are withheld from viewers by permission, not by hiding buttons',
                  'Your API key stays in session storage and is never persisted or synced',
                  'Without a provider the panel says it is not connected rather than improvising',
                ].map((item) => (
                  <li key={item} className="flex gap-2.5 text-base text-ink-muted">
                    <Sparkles className="mt-1 h-3.5 w-3.5 shrink-0 text-accent" />
                    {item}
                  </li>
                ))}
              </ul>
            </div>

            <div className="rounded-lg border border-line bg-surface p-4 font-mono text-sm shadow-pop">
              <p className="panel-label mb-3">Agent activity</p>
              <ul className="space-y-2">
                {[
                  ['done', 'Reading package.json'],
                  ['done', 'Inspecting src/App.tsx'],
                  ['done', 'Searching for "createClient"'],
                  ['running', 'Editing src/lib/supabase.ts'],
                  ['pending', 'Running build'],
                ].map(([state, label]) => (
                  <li key={label} className="flex items-center gap-2.5">
                    <span
                      className={
                        state === 'done'
                          ? 'text-positive'
                          : state === 'running'
                            ? 'text-accent'
                            : 'text-ink-faint'
                      }
                    >
                      {state === 'done' ? '✓' : state === 'running' ? '◐' : '○'}
                    </span>
                    <span className={state === 'pending' ? 'text-ink-faint' : 'text-ink'}>
                      {label}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="mt-4 border-t border-line pt-3 font-sans text-xs text-ink-faint">
                Illustration of the panel's output. In the product each row appears only after the
                corresponding tool call returns.
              </p>
            </div>
          </div>
        </section>

        {/* Collaboration */}
        <section id="collaboration" className="border-b border-line py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <SectionHeading
              eyebrow="Teams"
              title="Permissions the database enforces"
              body="Owner, admin, editor and viewer are Postgres policies. Hiding a button is a courtesy; the policy is the control."
            />
            <div className="mt-12 grid gap-4 md:grid-cols-4">
              {[
                { role: 'Owner', icon: KeyRound, body: 'Full control, including deletion and ownership transfer.' },
                { role: 'Admin', icon: Users, body: 'Manage members and settings; cannot delete the project.' },
                { role: 'Editor', icon: FileCode2, body: 'Read and write files, run builds, commit changes.' },
                { role: 'Viewer', icon: Lock, body: 'Read-only. Write tools are refused server side.' },
              ].map((item) => (
                <article key={item.role} className="rounded-lg border border-line bg-surface p-5">
                  <item.icon className="h-4 w-4 text-accent" />
                  <h3 className="mt-3 text-md font-semibold text-ink">{item.role}</h3>
                  <p className="mt-1.5 text-base text-ink-muted">{item.body}</p>
                </article>
              ))}
            </div>
            <p className="mx-auto mt-8 max-w-2xl text-center text-sm text-ink-faint">
              Membership, teams and activity tables ship with the schema and row level security
              policies. Live multi-cursor editing is not implemented yet, and the app does not
              pretend otherwise.
            </p>
          </div>
        </section>

        {/* Tech */}
        <section id="stack" className="border-b border-line py-20">
          <div className="mx-auto max-w-6xl px-4 sm:px-6">
            <SectionHeading eyebrow="Stack" title="Chosen for weight, not fashion" />
            <div className="mt-12 grid gap-px overflow-hidden rounded-lg border border-line bg-line sm:grid-cols-3">
              {TECH.map((item) => (
                <div key={item.name} className="flex items-baseline gap-2 bg-surface px-4 py-3">
                  <Layers aria-hidden className="h-3 w-3 shrink-0 text-accent" />
                  <span className="text-base font-medium text-ink">{item.name}</span>
                  <span className="text-sm text-ink-faint">{item.detail}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        {/* CTA */}
        <section className="py-24">
          <div className="mx-auto max-w-3xl px-4 text-center sm:px-6">
            <h2 className="text-2xl font-semibold text-ink sm:text-3xl">
              Open a project and start typing
            </h2>
            <p className="mx-auto mt-4 max-w-xl text-md text-ink-muted">
              Pick a template, import a ZIP, or pull in a public GitHub repository. Nothing to
              install, nothing to configure.
            </p>
            <div className="mt-8 flex flex-wrap justify-center gap-3">
              <Link to={signedIn ? '/dashboard' : '/signup'}>
                <Button variant="primary" size="lg" trailing={<ArrowRight className="h-4 w-4" />}>
                  {signedIn ? 'Open dashboard' : 'Get started'}
                </Button>
              </Link>
              <Link to="/signin">
                <Button size="lg" variant="outline">
                  I already have an account
                </Button>
              </Link>
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-line py-10">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-4 px-4 sm:flex-row sm:px-6">
          <div className="flex items-center gap-2 text-ink-muted">
            <span className="flex h-5 w-5 items-center justify-center rounded bg-accent text-accent-ink">
              <Hammer className="h-3 w-3" />
            </span>
            <span className="text-base font-medium text-ink">Forge IDE</span>
            <span className="text-sm text-ink-faint">A browser development environment</span>
          </div>
          <div className="flex items-center gap-5 text-sm text-ink-faint">
            <a
              className="inline-flex items-center gap-1.5 transition-colors hover:text-ink"
              href="https://github.com"
              target="_blank"
              rel="noreferrer noopener"
            >
              <Github className="h-3.5 w-3.5" /> Source
            </a>
            <Link className="transition-colors hover:text-ink" to="/signin">
              Sign in
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
