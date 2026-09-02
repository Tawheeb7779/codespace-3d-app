import { useEffect, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Cloud,
  CloudOff,
  Github,
  RefreshCw,
  TriangleAlert,
  Unlink,
} from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Primitives";
import { Modal } from "@/components/ui/Modal";
import { ConnectRepoDialog } from "@/components/github/ConnectRepoDialog";
import { RemoteBranchesDialog } from "@/components/github/RemoteBranchesDialog";
import { useGitStore, type RemoteResult } from "@/stores/gitStore";
import { useGithubStore } from "@/stores/githubStore";
import { useFileStore } from "@/stores/fileStore";
import { toast } from "@/stores/toastStore";
import { formatTimeAgo } from "@/lib/utils";

/**
 * The remote half of the Source Control panel.
 *
 * It answers, at a glance, the questions a developer actually has: which
 * repository and branch, how far ahead or behind, and whether the next button
 * press can lose anything. Every action is disabled while another is running,
 * because two pushes racing is exactly how work gets lost.
 */
export function RemoteBar() {
  const remote = useGitStore((s) => s.remote);
  const remoteBusy = useGitStore((s) => s.remoteBusy);
  const incoming = useGitStore((s) => s.incoming);
  const behind = useGitStore((s) => s.behind);
  const repo = useGitStore((s) => s.repo);
  const fetchRemote = useGitStore((s) => s.fetchRemote);
  const pullRemote = useGitStore((s) => s.pullRemote);
  const pushRemote = useGitStore((s) => s.pushRemote);
  const disconnectRemote = useGitStore((s) => s.disconnectRemote);
  const sync = useGitStore((s) => s.sync);
  const outgoing = useGitStore((s) => s.outgoing);
  const canWrite = useFileStore((s) => s.canWrite());
  const connection = useGithubStore((s) => s.status);
  const refreshConnection = useGithubStore((s) => s.refreshConnection);

  const [connectOpen, setConnectOpen] = useState(false);
  const [branchesOpen, setBranchesOpen] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);

  useEffect(() => {
    if (connection === "unknown") void refreshConnection();
  }, [connection, refreshConnection]);

  const report = (result: RemoteResult) => {
    if (result.ok) toast.success(result.message, result.detail);
    else toast.error(result.message, result.detail);
  };

  if (!remote) {
    return (
      <>
        <div className="border-b border-line p-2.5">
          <Button
            size="sm"
            className="w-full"
            disabled={!canWrite}
            onClick={() => setConnectOpen(true)}
          >
            <Github aria-hidden className="h-3.5 w-3.5" />
            Connect a GitHub repository
          </Button>
          <p className="mt-1.5 text-sm text-ink-faint">
            {canWrite
              ? "Fetch, pull and push against a real repository."
              : "Connecting a repository needs write access to this project."}
          </p>
        </div>
        <ConnectRepoDialog
          open={connectOpen}
          onClose={() => setConnectOpen(false)}
        />
      </>
    );
  }

  const state = sync();
  const ahead = state.ahead;
  const busy = remoteBusy !== null;
  const outgoingCommits = outgoing();

  const merging = Boolean(remote.merging);
  const summary =
    state.state === "merging"
      ? "Merge in progress"
      : state.state === "never-fetched"
        ? "Not fetched yet"
        : state.state === "remote-empty"
          ? "Branch not on GitHub yet"
          : state.state === "in-sync"
            ? "Up to date"
            : state.state === "diverged"
              ? "Diverged"
              : state.state === "ahead"
                ? "Ahead"
                : state.state === "behind"
                  ? "Behind"
                  : "";

  return (
    <>
      <div className="border-b border-line p-2.5">
        <div className="flex items-start gap-2">
          {connection === "connected" ? (
            <Cloud
              aria-hidden
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-positive"
            />
          ) : (
            <CloudOff
              aria-hidden
              className="mt-0.5 h-3.5 w-3.5 shrink-0 text-caution"
            />
          )}
          <div className="min-w-0 flex-1">
            <p className="truncate text-base text-ink">
              {remote.owner}/{remote.repo}
            </p>
            <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm text-ink-faint">
              <button
                type="button"
                aria-label={`Remote branches (tracking ${remote.branch})`}
                onClick={() => setBranchesOpen(true)}
                className="font-mono underline decoration-dotted underline-offset-2 hover:text-ink"
              >
                {remote.branch}
              </button>
              {remote.branch !== remote.defaultBranch && (
                <Badge>not default</Badge>
              )}
              <span>{summary}</span>
              {state.lastFetchedAt && (
                <span>fetched {formatTimeAgo(state.lastFetchedAt)}</span>
              )}
            </p>
          </div>
          <button
            type="button"
            aria-label="Disconnect this repository"
            title="Disconnect this repository"
            disabled={!canWrite || busy}
            onClick={() => setConfirmDisconnect(true)}
            className="mt-0.5 shrink-0 text-ink-faint transition-colors hover:text-danger disabled:opacity-40"
          >
            <Unlink aria-hidden className="h-3.5 w-3.5" />
          </button>
        </div>

        {(ahead > 0 || behind > 0) && (
          <p className="mt-2 flex items-center gap-3 text-sm">
            {ahead > 0 && (
              <span className="flex items-center gap-1 text-accent">
                <ArrowUp aria-hidden className="h-3 w-3" />
                {ahead} outgoing
              </span>
            )}
            {behind > 0 && (
              <span className="flex items-center gap-1 text-caution">
                <ArrowDown aria-hidden className="h-3 w-3" />
                {behind} incoming
              </span>
            )}
          </p>
        )}

        {merging && (
          <p className="mt-2 flex items-start gap-1.5 rounded border border-caution/40 bg-caution/5 p-2 text-sm text-ink">
            <TriangleAlert
              aria-hidden
              className="mt-0.5 h-3 w-3 shrink-0 text-caution"
            />
            <span>
              A pull left conflicts. Resolve the marked files, stage them and
              commit — that commit finishes the merge and can then be pushed.
            </span>
          </p>
        )}

        {!merging && state.state === "diverged" && (
          <p className="mt-2 flex items-start gap-1.5 rounded border border-caution/40 bg-caution/5 p-2 text-sm text-ink">
            <TriangleAlert
              aria-hidden
              className="mt-0.5 h-3 w-3 shrink-0 text-caution"
            />
            <span>
              Both sides have new commits. Pull to merge before you can push.
            </span>
          </p>
        )}

        {connection !== "connected" && (
          <p className="mt-2 rounded border border-caution/40 bg-caution/5 p-2 text-sm text-ink">
            GitHub is not connected. Connect it in Settings → Integrations to
            sync.
          </p>
        )}

        <div className="mt-2.5 flex gap-1.5">
          <Button
            size="xs"
            className="flex-1"
            disabled={busy || connection !== "connected"}
            loading={remoteBusy === "fetch"}
            onClick={() => void fetchRemote().then(report)}
          >
            <RefreshCw aria-hidden className="h-3 w-3" />
            Fetch
          </Button>
          <Button
            size="xs"
            className="flex-1"
            disabled={
              busy || merging || !canWrite || connection !== "connected"
            }
            loading={remoteBusy === "pull"}
            onClick={() => void pullRemote().then(report)}
          >
            <ArrowDown aria-hidden className="h-3 w-3" />
            Pull
          </Button>
          <Button
            size="xs"
            variant={ahead > 0 ? "primary" : undefined}
            className="flex-1"
            disabled={
              busy || merging || !canWrite || connection !== "connected"
            }
            loading={remoteBusy === "push"}
            onClick={() => void pushRemote().then(report)}
          >
            <ArrowUp aria-hidden className="h-3 w-3" />
            Push
          </Button>
        </div>

        {outgoingCommits.length > 0 && (
          <details className="mt-2 text-sm">
            <summary className="cursor-pointer text-ink-muted">
              {outgoingCommits.length} commit
              {outgoingCommits.length === 1 ? "" : "s"} to push
            </summary>
            <ul className="mt-1 space-y-0.5 pl-3">
              {outgoingCommits.slice(0, 10).map((commit) => (
                <li key={commit.id} className="truncate text-ink-faint">
                  <span className="font-mono">{commit.id.slice(0, 7)}</span>{" "}
                  {commit.message}
                </li>
              ))}
            </ul>
          </details>
        )}

        {incoming.length > 0 && (
          <details className="mt-1.5 text-sm">
            <summary className="cursor-pointer text-ink-muted">
              {incoming.length} commit{incoming.length === 1 ? "" : "s"} to pull
            </summary>
            <ul className="mt-1 space-y-0.5 pl-3">
              {incoming.slice(0, 10).map((commit) => (
                <li key={commit.sha} className="truncate text-ink-faint">
                  <span className="font-mono">{commit.sha.slice(0, 7)}</span>{" "}
                  {commit.message.split("\n")[0]}
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>

      <Modal
        open={confirmDisconnect}
        onClose={() => setConfirmDisconnect(false)}
        title="Disconnect this repository?"
        description={`Forge will stop syncing with ${remote.owner}/${remote.repo}. Your files and local history stay exactly as they are, and nothing on GitHub changes.`}
        size="sm"
        footer={
          <>
            <Button onClick={() => setConfirmDisconnect(false)}>Cancel</Button>
            <Button
              variant="danger"
              onClick={() =>
                void disconnectRemote().then(() => {
                  setConfirmDisconnect(false);
                  toast.success("Repository disconnected");
                })
              }
            >
              Disconnect
            </Button>
          </>
        }
      >
        {repo.initialized && useGitStore.getState().outgoing().length > 0 && (
          <p className="rounded border border-caution/40 bg-caution/5 p-2.5 text-sm text-ink">
            {useGitStore.getState().outgoing().length} commit(s) have not been
            pushed. They will remain in your local history, but Forge will
            forget where they were going.
          </p>
        )}
      </Modal>

      <ConnectRepoDialog
        open={connectOpen}
        onClose={() => setConnectOpen(false)}
      />
      <RemoteBranchesDialog
        open={branchesOpen}
        onClose={() => setBranchesOpen(false)}
      />
    </>
  );
}
