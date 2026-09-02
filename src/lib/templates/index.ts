import type { TemplateId } from '@/types';

export interface Template {
  id: TemplateId;
  name: string;
  description: string;
  /** Short badge shown on the card. */
  tag: string;
  /** True when the live preview can actually run this template in-browser. */
  runnable: boolean;
  /** Reason shown in the UI when `runnable` is false. */
  runnableNote?: string;
  files: Record<string, string>;
  dirs?: string[];
}

const pkg = (name: string, deps: Record<string, string>, extra: Record<string, unknown> = {}) =>
  `${JSON.stringify(
    {
      name,
      private: true,
      version: '0.1.0',
      type: 'module',
      ...extra,
      dependencies: deps,
    },
    null,
    2,
  )}\n`;

const README = (title: string, body: string) => `# ${title}\n\n${body}\n`;

const vanilla: Template = {
  id: 'vanilla',
  name: 'Vanilla HTML/CSS/JS',
  description: 'Zero build step. Ships an index.html, a stylesheet and a module script.',
  tag: 'Static',
  runnable: true,
  files: {
    'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Vanilla App</title>
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <main class="shell">
      <h1>Vanilla App</h1>
      <p>Edit <code>src/main.js</code> and the preview reloads.</p>
      <button id="counter" type="button">Clicked 0 times</button>
    </main>
    <script type="module" src="./src/main.js"></script>
  </body>
</html>
`,
    'styles.css': `:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font-family: ui-sans-serif, system-ui, sans-serif;
  background: #0b0f17;
  color: #e6e9f5;
}
.shell { text-align: center; padding: 2rem; }
h1 { margin: 0 0 .5rem; font-size: 2rem; letter-spacing: -0.02em; }
p { margin: 0 0 1.5rem; color: #98a0b8; }
code { background: #161b26; padding: .15rem .35rem; border-radius: 4px; }
button {
  font: inherit;
  padding: .6rem 1.1rem;
  border-radius: 8px;
  border: 1px solid #2a3243;
  background: #141a26;
  color: #e6e9f5;
  cursor: pointer;
  transition: border-color .15s ease, transform .15s ease;
}
button:hover { border-color: #4d8eff; transform: translateY(-1px); }
`,
    'src/main.js': `const button = document.querySelector('#counter');
let count = 0;

button.addEventListener('click', () => {
  count += 1;
  button.textContent = \`Clicked \${count} time\${count === 1 ? '' : 's'}\`;
  console.log('counter', count);
});

console.log('Vanilla app ready');
`,
    'README.md': README('Vanilla App', 'Open `index.html` and press Run to preview.'),
  },
};

const reactJs: Template = {
  id: 'react',
  name: 'React',
  description: 'React 18 with JSX, a component folder and hot preview.',
  tag: 'SPA',
  runnable: true,
  files: {
    'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>React App</title>
    <link rel="stylesheet" href="./src/styles.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.jsx"></script>
  </body>
</html>
`,
    'src/main.jsx': `import { createRoot } from 'react-dom/client';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(<App />);
`,
    'src/App.jsx': `import { useState } from 'react';
import Counter from './components/Counter.jsx';

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main className="shell">
      <h1>React App</h1>
      <p>Edit <code>src/App.jsx</code> and save to reload the preview.</p>
      <Counter count={count} onIncrement={() => setCount((c) => c + 1)} />
    </main>
  );
}
`,
    'src/components/Counter.jsx': `export default function Counter({ count, onIncrement }) {
  return (
    <button type="button" onClick={onIncrement}>
      Clicked {count} {count === 1 ? 'time' : 'times'}
    </button>
  );
}
`,
    'src/styles.css': `:root { color-scheme: dark; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font-family: ui-sans-serif, system-ui, sans-serif;
  background: #0b0f17;
  color: #e6e9f5;
}
.shell { text-align: center; padding: 2rem; }
button {
  font: inherit;
  padding: .6rem 1.1rem;
  border-radius: 8px;
  border: 1px solid #2a3243;
  background: #141a26;
  color: inherit;
  cursor: pointer;
}
`,
    'package.json': pkg('react-app', { react: '^18.3.1', 'react-dom': '^18.3.1' }),
    'README.md': README('React App', 'Press Run to bundle with esbuild and preview.'),
  },
};

const reactTs: Template = {
  id: 'react-ts',
  name: 'React + TypeScript',
  description: 'Typed React starter with tsconfig, typed props and strict mode.',
  tag: 'Typed',
  runnable: true,
  files: {
    'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>React TS App</title>
    <link rel="stylesheet" href="./src/styles.css" />
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="./src/main.tsx"></script>
  </body>
</html>
`,
    'src/main.tsx': `import { createRoot } from 'react-dom/client';
import App from './App';

const container = document.getElementById('root');
if (!container) throw new Error('Root element #root is missing from index.html');

createRoot(container).render(<App />);
`,
    'src/App.tsx': `import { useState } from 'react';
import { Counter } from './components/Counter';

export default function App() {
  const [count, setCount] = useState(0);
  return (
    <main className="shell">
      <h1>React + TypeScript</h1>
      <p>Types are checked by the editor as you write.</p>
      <Counter count={count} onIncrement={() => setCount((c) => c + 1)} />
    </main>
  );
}
`,
    'src/components/Counter.tsx': `interface CounterProps {
  count: number;
  onIncrement: () => void;
}

export function Counter({ count, onIncrement }: CounterProps) {
  return (
    <button type="button" onClick={onIncrement}>
      Clicked {count} {count === 1 ? 'time' : 'times'}
    </button>
  );
}
`,
    'src/styles.css': `:root { color-scheme: dark; }
body {
  margin: 0;
  min-height: 100vh;
  display: grid;
  place-items: center;
  font-family: ui-sans-serif, system-ui, sans-serif;
  background: #0b0f17;
  color: #e6e9f5;
}
.shell { text-align: center; padding: 2rem; }
button {
  font: inherit;
  padding: .6rem 1.1rem;
  border-radius: 8px;
  border: 1px solid #2a3243;
  background: #141a26;
  color: inherit;
  cursor: pointer;
}
`,
    'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
`,
    'package.json': pkg('react-ts-app', { react: '^18.3.1', 'react-dom': '^18.3.1' }),
    'README.md': README('React + TypeScript', 'Press Run to bundle and preview.'),
  },
};

const viteTs: Template = {
  id: 'vite-ts',
  name: 'Vite + TypeScript',
  description: 'Framework-free TypeScript entry with a Vite config for local dev.',
  tag: 'Bundler',
  runnable: true,
  files: {
    'index.html': `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Vite TS</title>
  </head>
  <body>
    <div id="app"></div>
    <script type="module" src="./src/main.ts"></script>
  </body>
</html>
`,
    'src/main.ts': `import { render } from './ui';

render(document.querySelector<HTMLDivElement>('#app')!);
`,
    'src/ui.ts': `export function render(target: HTMLElement): void {
  target.innerHTML = \`
    <main style="font-family: system-ui; color: #e6e9f5; background: #0b0f17; min-height: 100vh; display: grid; place-items: center;">
      <div style="text-align:center">
        <h1>Vite + TypeScript</h1>
        <p style="color:#98a0b8">Edit <code>src/ui.ts</code> to change this view.</p>
      </div>
    </main>
  \`;
}
`,
    'vite.config.ts': `import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5173 },
});
`,
    'tsconfig.json': `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "lib": ["ES2022", "DOM"],
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
`,
    'package.json': pkg('vite-ts-app', {}, { devDependencies: { vite: '^7.0.0', typescript: '^5.6.0' } }),
    'README.md': README('Vite + TypeScript', 'Press Run to bundle and preview.'),
  },
};

const node: Template = {
  id: 'node',
  name: 'Node.js',
  description: 'Node service scaffold with an HTTP handler and a unit test.',
  tag: 'Server',
  runnable: false,
  runnableNote:
    'The browser preview cannot bind a TCP port. Run this project with Node locally; the editor, search, VCS and export all work here.',
  files: {
    'src/server.js': `import { createServer } from 'node:http';
import { route } from './router.js';

const port = Number(process.env.PORT ?? 3000);

createServer(async (req, res) => {
  const result = await route(req.method ?? 'GET', req.url ?? '/');
  res.writeHead(result.status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(result.body));
}).listen(port, () => {
  console.log(\`listening on http://localhost:\${port}\`);
});
`,
    'src/router.js': `export async function route(method, url) {
  if (method === 'GET' && url === '/health') {
    return { status: 200, body: { ok: true, uptime: process.uptime() } };
  }
  return { status: 404, body: { error: 'Not found', method, url } };
}
`,
    'test/router.test.js': `import assert from 'node:assert/strict';
import test from 'node:test';
import { route } from '../src/router.js';

test('health check responds 200', async () => {
  const result = await route('GET', '/health');
  assert.equal(result.status, 200);
  assert.equal(result.body.ok, true);
});

test('unknown routes respond 404', async () => {
  const result = await route('GET', '/nope');
  assert.equal(result.status, 404);
});
`,
    'package.json': pkg('node-service', {}, { scripts: { start: 'node src/server.js', test: 'node --test' } }),
    'README.md': README('Node Service', 'Run `node src/server.js` locally. `node --test` runs the suite.'),
  },
};

const next: Template = {
  id: 'next',
  name: 'Next.js starter',
  description: 'App Router layout, a page and a route handler.',
  tag: 'Framework',
  runnable: false,
  runnableNote:
    'Next.js needs its own dev server and React Server Components runtime, which cannot run inside the browser preview. Editing, search, VCS and export are fully available.',
  files: {
    'app/layout.tsx': `import type { ReactNode } from 'react';
import './globals.css';

export const metadata = { title: 'Next Starter' };

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
`,
    'app/page.tsx': `export default function Page() {
  return (
    <main className="shell">
      <h1>Next.js Starter</h1>
      <p>Edit app/page.tsx to get started.</p>
    </main>
  );
}
`,
    'app/api/health/route.ts': `export async function GET() {
  return Response.json({ ok: true });
}
`,
    'app/globals.css': `body {
  margin: 0;
  font-family: ui-sans-serif, system-ui, sans-serif;
  background: #0b0f17;
  color: #e6e9f5;
}
.shell { min-height: 100vh; display: grid; place-items: center; text-align: center; }
`,
    'package.json': pkg(
      'next-starter',
      { next: '^15.0.0', react: '^18.3.1', 'react-dom': '^18.3.1' },
      { scripts: { dev: 'next dev', build: 'next build', start: 'next start' } },
    ),
    'README.md': README('Next.js Starter', 'Run `npm run dev` locally to start the Next dev server.'),
  },
};

const blank: Template = {
  id: 'blank',
  name: 'Empty project',
  description: 'A README and an empty src folder. Bring your own structure.',
  tag: 'Blank',
  runnable: true,
  files: {
    'README.md': README('New Project', 'Nothing here yet. Create your first file in `src/`.'),
  },
  dirs: ['src'],
};

export const TEMPLATES: Template[] = [vanilla, reactJs, reactTs, viteTs, node, next, blank];

export function getTemplate(id: TemplateId): Template {
  return TEMPLATES.find((t) => t.id === id) ?? blank;
}
