import { useEffect, useState } from 'react';
import { GitBranch, Lock, Search, Unlock } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Badge, EmptyState, Spinner } from '@/components/ui/Primitives';
import { useGithubStore } from '@/stores/githubStore';
import type { GithubRepo } from '@/lib/github/types';
import { cx } from '@/lib/utils';

/**
 * Browse the repositories the connected account can reach.
 *
 * The list is paged rather than exhaustive: an account with a thousand
 * repositories should not cost a thousand rows of DOM or a rate-limit budget
 * to open a picker.
 */
export function RepoBrowser({
  onSelect,
  selected,
  requireWrite = false,
}: {
  onSelect: (repo: GithubRepo) => void;
  selected?: GithubRepo | null;
  /** Grey out repositories the account cannot push to. */
  requireWrite?: boolean;
}) {
  const { repos, loadingRepos, reposError, hasNextPage, page, searchRepos } = useGithubStore();
  const [term, setTerm] = useState('');

  useEffect(() => {
    void searchRepos('', 1);
  }, [searchRepos]);

  useEffect(() => {
    const timer = setTimeout(() => void searchRepos(term, 1), 350);
    return () => clearTimeout(timer);
  }, [term, searchRepos]);

  return (
    <div className="space-y-3">
      <div className="relative">
        <Search aria-hidden className="pointer-events-none absolute left-2 top-2 h-3.5 w-3.5 text-ink-faint" />
        <input
          type="search"
          aria-label="Search repositories"
          placeholder="Search your repositories"
          value={term}
          onChange={(event) => setTerm(event.target.value)}
          className="h-8 w-full rounded border border-line bg-surface-sunken pl-7 pr-2 text-base text-ink placeholder:text-ink-faint focus:border-accent focus:outline-none"
        />
      </div>

      {reposError && (
        <p role="alert" className="rounded border border-danger/40 bg-danger/5 p-2.5 text-sm text-danger">
          {reposError}
        </p>
      )}

      <div className="scrollbar-thin max-h-72 overflow-y-auto rounded border border-line">
        {loadingRepos ? (
          <div className="flex items-center gap-2 p-4 text-sm text-ink-faint">
            <Spinner className="h-3.5 w-3.5" /> Loading repositories…
          </div>
        ) : !repos.length ? (
          <EmptyState
            title={term ? 'No repositories match' : 'No repositories'}
            description={
              term
                ? `Nothing the connected account can see matches "${term}".`
                : 'The connected GitHub account has no repositories yet. Create one below.'
            }
          />
        ) : (
          <ul role="list">
            {repos.map((repo) => {
              const blocked = requireWrite && !repo.canPush;
              const active = selected?.id === repo.id;
              return (
                <li key={repo.id}>
                  <button
                    type="button"
                    disabled={blocked}
                    aria-current={active}
                    onClick={() => onSelect(repo)}
                    className={cx(
                      'flex w-full items-start gap-2 border-b border-line px-2.5 py-2 text-left last:border-0',
                      blocked
                        ? 'cursor-not-allowed opacity-50'
                        : active
                          ? 'bg-accent-soft'
                          : 'hover:bg-surface-raised',
                    )}
                  >
                    {repo.private ? (
                      <Lock aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-caution" />
                    ) : (
                      <Unlock aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ink-faint" />
                    )}
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-base text-ink">{repo.fullName}</span>
                        {repo.private && <Badge>private</Badge>}
                        {repo.empty && <Badge tone="caution">empty</Badge>}
                        {blocked && <Badge tone="caution">read-only</Badge>}
                      </span>
                      <span className="mt-0.5 flex items-center gap-2 text-sm text-ink-faint">
                        <span className="flex items-center gap-1">
                          <GitBranch aria-hidden className="h-3 w-3" />
                          {repo.defaultBranch}
                        </span>
                        {repo.updatedAt && (
                          <span>updated {new Date(repo.updatedAt).toLocaleDateString()}</span>
                        )}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {(page > 1 || hasNextPage) && (
        <div className="flex items-center justify-between text-sm text-ink-faint">
          <Button
            size="xs"
            disabled={page <= 1 || loadingRepos}
            onClick={() => void searchRepos(term, page - 1)}
          >
            Previous
          </Button>
          <span>Page {page}</span>
          <Button
            size="xs"
            disabled={!hasNextPage || loadingRepos}
            onClick={() => void searchRepos(term, page + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </div>
  );
}
