/**
 * A scripted OpenAI-compatible endpoint for the agent browser tests.
 *
 * Only the *model* is scripted. Everything the agent does with the model's
 * output — tool dispatch, path validation, approval gating, the real build,
 * the change ledger — is the shipping code running in the browser. A test that
 * mocked the tools would prove nothing.
 *
 * The turn served is derived from how many assistant messages the client
 * already has, so the server is stateless and a cleared conversation restarts
 * the script.
 *
 *   node e2e/agent-provider.mjs
 */
import { createServer } from 'node:http';

const PORT = Number(process.env.FORGE_AGENT_PORT ?? 8866);

const tool = (id, name, args) => ({
  id,
  type: 'function',
  function: { name, arguments: JSON.stringify(args) },
});

const SCENARIOS = {
  /** Plan, read, edit, build, report. The happy path. */
  edit: [
    {
      text: 'Plan:\n1. Read src/main.js\n2. Change the greeting\n3. Build to verify',
      tools: [tool('c1', 'read_file', { path: 'src/main.js' })],
    },
    {
      tools: [
        tool('c2', 'edit_file', {
          path: 'src/main.js',
          old_string: 'Clicked',
          new_string: 'Pressed',
        }),
      ],
    },
    { tools: [tool('c3', 'run_build', {})] },
    { text: 'Changed the label to "Pressed" and the build passes.' },
  ],

  /** Reads the same file twice: the second read must be served from cache. */
  cached: [
    { tools: [tool('c1', 'read_file', { path: 'src/main.js' })] },
    { tools: [tool('c2', 'read_file', { path: 'src/main.js' })] },
    { text: 'I already had that file.' },
  ],

  /** A destructive action that must stop and ask. */
  destructive: [
    { tools: [tool('c1', 'delete_file', { path: 'styles.css' })] },
    { text: 'I stopped at the delete.' },
  ],

  /** Path escapes: every one must be refused. */
  escape: [
    { tools: [tool('c1', 'read_file', { path: '../../etc/passwd' })] },
    { tools: [tool('c2', 'write_file', { path: '/etc/passwd', content: 'x' })] },
    { tools: [tool('c3', 'read_file', { path: '.env' })] },
    { text: 'All three were refused.' },
  ],

  /** Break the build, see it fail, fix it, verify. */
  recover: [
    {
      tools: [
        tool('c1', 'write_file', { path: 'src/main.js', content: 'const broken = ;\n' }),
      ],
    },
    { tools: [tool('c2', 'run_build', {})] },
    {
      tools: [
        tool('c3', 'write_file', {
          path: 'src/main.js',
          content: "document.title = 'recovered';\n",
        }),
      ],
    },
    { tools: [tool('c4', 'run_build', {})] },
    { text: 'The syntax error is fixed and the build passes.' },
  ],

  /** Long-running so a test can cancel it mid-flight. */
  slow: Array.from({ length: 12 }, (_, index) => ({
    tools: [tool(`c${index}`, 'run_command', { command: `echo step-${index}` })],
  })),
};

const server = createServer((req, res) => {
  res.setHeader('access-control-allow-origin', '*');
  res.setHeader('access-control-allow-headers', '*');
  res.setHeader('access-control-allow-methods', '*');
  if (req.method === 'OPTIONS') return res.writeHead(204).end();

  const scenario = new URL(req.url, 'http://x').pathname.split('/')[1];
  if (!SCENARIOS[scenario]) return res.writeHead(404).end('unknown scenario');

  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    let messages = [];
    try {
      messages = JSON.parse(raw).messages ?? [];
    } catch {
      /* keep [] */
    }
    const index = messages.filter((m) => m.role === 'assistant').length;
    const turn = SCENARIOS[scenario][index] ?? { text: 'Done.' };
    console.log(`[${scenario}] turn ${index}: ${turn.tools ? turn.tools.map((t) => t.function.name).join(',') : 'text'}`);

    const message = turn.tools
      ? { role: 'assistant', content: turn.text ?? null, tool_calls: turn.tools }
      : { role: 'assistant', content: turn.text };

    const send = () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: 'agent-mock',
          choices: [{ index: 0, message, finish_reason: turn.tools ? 'tool_calls' : 'stop' }],
        }),
      );
    };

    // The `slow` scenario models a model that takes real time to answer, which
    // is what gives a test a window in which to press Stop.
    if (scenario === 'slow') setTimeout(send, 2500);
    else send();
  });
});

server.listen(PORT, '127.0.0.1', () => console.log(`agent provider on http://127.0.0.1:${PORT}`));
