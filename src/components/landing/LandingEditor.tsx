import { useEffect, useRef, useState } from 'react';
import Editor from '@monaco-editor/react';
import { setupMonaco } from '@/lib/monaco';
import { Spinner } from '@/components/ui/Primitives';
import { cx } from '@/lib/utils';

/**
 * A real Monaco instance embedded in the marketing page — the same editor the
 * IDE uses, not a screenshot. It mounts only once the section scrolls into
 * view so the landing page's first paint stays fast.
 */

const SAMPLES: Array<{ path: string; language: string; code: string }> = [
  {
    path: 'src/store/useSession.ts',
    language: 'typescript',
    code: `import { create } from 'zustand';

interface Session {
  userId: string | null;
  token: string | null;
  expiresAt: number;
}

interface SessionState extends Session {
  signIn: (session: Session) => void;
  signOut: () => void;
  isValid: () => boolean;
}

export const useSession = create<SessionState>((set, get) => ({
  userId: null,
  token: null,
  expiresAt: 0,

  signIn: (session) => set(session),
  signOut: () => set({ userId: null, token: null, expiresAt: 0 }),

  isValid: () => {
    const { token, expiresAt } = get();
    return Boolean(token) && expiresAt > Date.now();
  },
}));
`,
  },
  {
    path: 'src/routes/handler.ts',
    language: 'typescript',
    code: `type Handler = (request: Request) => Promise<Response>;

const routes = new Map<string, Handler>();

export function get(path: string, handler: Handler): void {
  routes.set(\`GET \${path}\`, handler);
}

export async function dispatch(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const handler = routes.get(\`\${request.method} \${url.pathname}\`);

  if (!handler) {
    return Response.json({ error: 'Not found' }, { status: 404 });
  }

  try {
    return await handler(request);
  } catch (error) {
    console.error('handler failed', error);
    return Response.json({ error: 'Internal error' }, { status: 500 });
  }
}
`,
  },
  {
    path: 'styles/tokens.css',
    language: 'css',
    code: `:root {
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --radius: 6px;

  --surface: #0e121a;
  --ink: #e2e8f5;
  --accent: #608fff;
}

.panel {
  background: var(--surface);
  color: var(--ink);
  border-radius: var(--radius);
  padding: var(--space-3);
  border: 1px solid rgb(255 255 255 / 0.06);
}
`,
  },
];

export function LandingEditor() {
  const [visible, setVisible] = useState(false);
  const [active, setActive] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || visible) return;
    if (typeof IntersectionObserver === 'undefined') {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '200px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  const sample = SAMPLES[active];

  return (
    <div
      ref={containerRef}
      className="overflow-hidden rounded-xl border border-line bg-surface shadow-pop"
    >
      <div className="flex items-center gap-2 border-b border-line bg-surface-raised px-3 py-2">
        <div className="flex gap-1.5" aria-hidden>
          <span className="h-2.5 w-2.5 rounded-full bg-danger/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-caution/70" />
          <span className="h-2.5 w-2.5 rounded-full bg-positive/70" />
        </div>
        <div role="tablist" aria-label="Sample files" className="ml-2 flex min-w-0 gap-1 overflow-x-auto">
          {SAMPLES.map((item, index) => (
            <button
              key={item.path}
              role="tab"
              type="button"
              aria-selected={index === active}
              onClick={() => setActive(index)}
              className={cx(
                'shrink-0 rounded-sm px-2 py-1 font-mono text-xs transition-colors',
                index === active
                  ? 'bg-surface text-ink'
                  : 'text-ink-faint hover:bg-surface hover:text-ink-muted',
              )}
            >
              {item.path.split('/').pop()}
            </button>
          ))}
        </div>
      </div>

      <div className="h-[340px] sm:h-[420px]">
        {visible ? (
          <Editor
            key={sample.path}
            height="100%"
            theme="forge-dark"
            language={sample.language}
            defaultValue={sample.code}
            path={sample.path}
            beforeMount={() => setupMonaco()}
            loading={
              <div className="flex h-full items-center justify-center">
                <Spinner />
              </div>
            }
            options={{
              fontSize: 13,
              fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, monospace",
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              padding: { top: 14, bottom: 14 },
              renderLineHighlight: 'all',
              scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8 },
            }}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-ink-faint">
            Editor loads when this section is in view
          </div>
        )}
      </div>

      <p className="border-t border-line px-3 py-1.5 text-xs text-ink-faint">
        Live Monaco editor. Type in it — IntelliSense, folding and multi-cursor all work here.
      </p>
    </div>
  );
}
