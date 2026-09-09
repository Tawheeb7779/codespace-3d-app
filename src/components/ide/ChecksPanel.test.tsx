import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

/**
 * The person's view of the container's checks, and the two things it must never
 * become.
 *
 * It must never become a shell. The panel offers the scripts the gateway said
 * this project defines and nothing else: there is no text field, so there is no
 * path from a keystroke here to a command line in the container.
 *
 * And it must never round a failure up. A red suite is shown as FAILED with its
 * exit code and its real output; a refusal — the gateway declining a script
 * outside its allowlist — is shown as a refusal. Either of those rendered as a
 * pass would be the product telling somebody their project is fine when it is
 * not, which is the same dishonesty as an agent reporting tests it never ran.
 */

const checkAnswer = vi.fn();
const connected = vi.fn(() => true);

vi.mock('@/lib/ai/workspaceBridge', () => ({
  workspaceCheck: (request: unknown) => checkAnswer(request),
  workspaceConnected: () => connected(),
  subscribeWorkspace: () => () => undefined,
  workspaceContainerId: () => 'tacode-test',
}));

const { ChecksPanel } = await import('@/components/ide/ChecksPanel');

beforeEach(() => {
  checkAnswer.mockReset();
  connected.mockReset();
  connected.mockReturnValue(true);
});

/** List the given scripts, then answer a run with `result`. */
function workspaceOffering(scripts: string[], result?: Record<string, unknown>) {
  checkAnswer.mockImplementation(async (request: { op: string }) =>
    request.op === 'list' ? { ok: true, available: scripts } : (result ?? { ok: true }),
  );
}

describe('a workspace that is not attached', () => {
  it('says so instead of offering checks that cannot run', async () => {
    connected.mockReturnValue(false);

    render(<ChecksPanel />);

    expect(await screen.findByText(/no container workspace attached/i)).toBeTruthy();
    expect(checkAnswer).not.toHaveBeenCalled();
  });
});

describe('which checks are offered', () => {
  it('offers exactly what the gateway said the project defines', async () => {
    workspaceOffering(['test', 'lint']);

    render(<ChecksPanel />);

    expect(await screen.findByRole('button', { name: 'test' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'lint' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'build' })).toBeNull();
  });

  it('says a project defines none rather than offering a way to type one', async () => {
    workspaceOffering([]);

    render(<ChecksPanel />);

    expect(await screen.findByText(/defines none of the checks/i)).toBeTruthy();
  });

  /** The whole reason this is not a terminal: nothing here accepts free text. */
  it('has no field to type a command into', async () => {
    workspaceOffering(['test']);

    render(<ChecksPanel />);
    await screen.findByRole('button', { name: 'test' });

    expect(screen.queryByRole('textbox')).toBeNull();
    expect(document.querySelector('input')).toBeNull();
    expect(document.querySelector('textarea')).toBeNull();
  });
});

describe('running a check', () => {
  it('reports a passing check with its exit code', async () => {
    workspaceOffering(['test'], {
      ok: true,
      result: { script: 'test', ok: true, exitCode: 0, output: '42 passed\n', truncated: false },
    });

    render(<ChecksPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'test' }));

    await waitFor(() => expect(screen.getByText(/npm run test — passed/)).toBeTruthy());
    expect(screen.getByText('exit 0')).toBeTruthy();
    expect(screen.getByText(/42 passed/)).toBeTruthy();
  });

  it('reports a failing check as FAILED, with the output that failed', async () => {
    workspaceOffering(['test'], {
      ok: true,
      result: {
        script: 'test',
        ok: false,
        exitCode: 1,
        output: 'FAIL src/app.test.ts\n  expected 2 to be 3\n',
        truncated: false,
      },
    });

    render(<ChecksPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'test' }));

    await waitFor(() => expect(screen.getByText(/npm run test — FAILED/)).toBeTruthy());
    expect(screen.getByText('exit 1')).toBeTruthy();
    expect(screen.getByText(/expected 2 to be 3/)).toBeTruthy();
    expect(screen.queryByText(/passed/)).toBeNull();
  });

  it('shows a refusal as a refusal, not as a check that passed', async () => {
    workspaceOffering(['test'], {
      ok: false,
      message: '"deploy" is not a check this workspace will run.',
    });

    render(<ChecksPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'test' }));

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toMatch(/not a check/i);
    expect(screen.queryByText(/passed/)).toBeNull();
  });

  it('says when output was truncated rather than presenting a partial log as whole', async () => {
    workspaceOffering(['build'], {
      ok: true,
      result: { script: 'build', ok: true, exitCode: 0, output: 'START…END', truncated: true },
    });

    render(<ChecksPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'build' }));

    await waitFor(() => expect(screen.getByText(/output truncated/i)).toBeTruthy());
  });

  it('sends the script name alone, with no command or arguments', async () => {
    workspaceOffering(['lint'], {
      ok: true,
      result: { script: 'lint', ok: true, exitCode: 0, output: '', truncated: false },
    });

    render(<ChecksPanel />);
    await userEvent.click(await screen.findByRole('button', { name: 'lint' }));

    await waitFor(() =>
      expect(checkAnswer).toHaveBeenCalledWith({ op: 'run', script: 'lint' }),
    );
    const run = checkAnswer.mock.calls.map(([request]) => request).find((r) => r.op === 'run');
    expect(Object.keys(run)).toEqual(['op', 'script']);
  });
});
