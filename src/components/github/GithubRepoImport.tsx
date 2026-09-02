import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/Button';
import { Input, Select } from '@/components/ui/Field';
import { Spinner } from '@/components/ui/Primitives';
import { GithubConnection } from '@/components/github/GithubConnection';
import { RepoBrowser } from '@/components/github/RepoBrowser';
import { useGithubStore } from '@/stores/githubStore';
import { useGitStore } from '@/stores/gitStore';
import { useProjectStore } from '@/stores/projectStore';
import { useFileStore } from '@/stores/fileStore';
import { githubClient } from '@/lib/github/gateway';
import { newRemoteRef } from '@/lib/github/remote';
import { repositoryFor } from '@/lib/repo';
import { commitFiles, initRepo } from '@/lib/vcs';
import { useAuthStore } from '@/stores/authStore';
import { toast } from '@/stores/toastStore';
import type { GithubBranch, GithubRepo } from '@/lib/github/types';
import { dirname } from '@/lib/vfs';
import { errorMessage } from '@/lib/utils';

/**
 * Import a repository the connected account can reach — including private ones,
 * which the public zipball path cannot do.
 *
 * The repository is read through the Git Data API, so the new project starts
 * out connected: it knows which commit it came from and can pull and push
 * immediately. Every path goes through the shared VFS validator on the way in,
 * and anything skipped is listed rather than silently dropped.
 */
export function GithubRepoImport({ onDone }: { onDone: () => void }) {
  const navigate = useNavigate();
  const status = useGithubStore((s) => s.status);
  const listBranches = useGithubStore((s) => s.listBranches);
  const create = useProjectStore((s) => s.create);

  const [repo, setRepo] = useState<GithubRepo | null>(null);
  const [branches, setBranches] = useState<GithubBranch[]>([]);
  const [branch, setBranch] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [skipped, setSkipped] = useState<Array<{ path: string; reason: string }>>([]);

  useEffect(() => {
    if (!repo) return;
    setBranch(repo.defaultBranch);
    setName(repo.name);
    setSkipped([]);
    let cancelled = false;
    listBranches(repo)
      .then((items) => !cancelled && setBranches(items))
      .catch(() => !cancelled && setBranches([]));
    return () => {
      cancelled = true;
    };
  }, [repo, listBranches]);

  const run = async () => {
    if (!repo) return;
    setBusy(true);
    setError(null);
    setSkipped([]);
    try {
      const client = githubClient();
      const target = branch || repo.defaultBranch;
      const spec = { owner: repo.owner, repo: repo.name };

      setStep(`Reading ${repo.fullName}@${target}…`);
      const tip = await client.branchTip(spec, target);
      if (!tip) {
        setError(`${target} has no commits on GitHub yet. Create an empty project and push instead.`);
        return;
      }
      const tree = await client.readTree(spec, tip);
      if (tree.truncated) {
        setError('That repository is too large for Forge to read in one request.');
        return;
      }

      const files: Record<string, string> = {};
      const dirs = new Set<string>();
      for (const file of tree.files) {
        files[file.path] = file.content ?? '';
        let parent = dirname(file.path);
        while (parent) {
          dirs.add(parent);
          parent = dirname(parent);
        }
      }
      setSkipped(tree.skipped);

      setStep('Creating the project…');
      const project = await create({
        name: name.trim() || repo.name,
        description: repo.description || `Imported from ${repo.fullName}`,
        template: 'blank',
        files,
        dirs: [...dirs].sort(),
      });

      /*
       * Give the project the history a clone would have: one local commit
       * holding exactly the remote tip's tree, recorded as the synced point.
       * Without this the project arrives with a remote but no repository, the
       * Source Control panel offers "Initialize repository" instead of the
       * sync controls, and the first push would try to send a fresh root
       * commit over the branch it came from.
       */
      const author = {
        name: useAuthStore.getState().user?.displayName ?? 'Forge',
        email: useAuthStore.getState().user?.email ?? 'you@localhost',
      };
      const head = await client.commit(spec, tip);
      const { repo: vcsRepo, commit } = commitFiles(
        initRepo(),
        files,
        head.message.split('\n')[0].slice(0, 200) || `Imported ${repo.fullName}@${tip.slice(0, 7)}`,
        author,
        [],
      );

      const remote = {
        ...newRemoteRef({
          owner: repo.owner,
          repo: repo.name,
          repoId: repo.id,
          defaultBranch: repo.defaultBranch,
          branch: target,
        }),
        lastFetchedSha: tip,
        lastSyncedSha: tip,
        lastFetchedAt: Date.now(),
        syncedTree: { ...files },
        pushedUpTo: commit.id,
        commitShas: { [commit.id]: tip },
      };

      const store = repositoryFor(useAuthStore.getState().user?.provider);
      await store.saveVcs(project.id, vcsRepo);
      await store.saveRemote(project.id, remote);

      toast.success(
        'Repository imported',
        `${Object.keys(files).length} files from ${repo.fullName}@${target.slice(0, 20)}`,
      );
      onDone();
      // The workspace loads both from storage on mount; close the current
      // project first so nothing from it leaks into the new one.
      await useFileStore.getState().close();
      useGitStore.setState({ repo: vcsRepo, remote });
      navigate(`/project/${project.id}`);
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
      setStep('');
    }
  };

  if (status !== 'connected') {
    return (
      <div className="space-y-3">
        <p className="text-sm text-ink-muted">
          Connect GitHub to import a repository you own or collaborate on, including private ones.
        </p>
        <GithubConnection compact />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <RepoBrowser onSelect={setRepo} selected={repo} />

      {repo && (
        <>
          <Select
            label="Branch"
            value={branch}
            onChange={(event) => setBranch(event.target.value)}
            options={
              branches.length
                ? branches.map((item) => ({ value: item.name, label: item.name }))
                : [{ value: repo.defaultBranch, label: repo.defaultBranch }]
            }
          />
          <Input
            label="Project name"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
          />
          <Button variant="primary" loading={busy} disabled={busy} onClick={() => void run()}>
            Import {repo.fullName}
          </Button>
        </>
      )}

      {busy && step && (
        <p className="flex items-center gap-2 text-sm text-ink-faint">
          <Spinner className="h-3.5 w-3.5" /> {step}
        </p>
      )}

      {error && (
        <p role="alert" className="rounded border border-danger/40 bg-danger/5 p-2.5 text-sm text-danger">
          {error}
        </p>
      )}

      {skipped.length > 0 && (
        <details className="text-sm text-ink-muted">
          <summary className="cursor-pointer text-caution">{skipped.length} entries skipped</summary>
          <ul className="scrollbar-thin mt-2 max-h-32 space-y-0.5 overflow-y-auto font-mono text-xs">
            {skipped.slice(0, 100).map((entry) => (
              <li key={entry.path} className="truncate">
                {entry.path} — {entry.reason}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}
