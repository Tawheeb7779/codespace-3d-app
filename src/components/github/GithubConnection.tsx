import { useEffect, useState } from 'react';
import { CheckCircle2, Github, Loader2, LogOut, RefreshCw, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Badge } from '@/components/ui/Primitives';
import { useGithubStore } from '@/stores/githubStore';
import { isSupabaseConfigured } from '@/lib/supabase';
import { toast } from '@/stores/toastStore';
import { errorMessage } from '@/lib/utils';

/**
 * Connect, inspect and disconnect the GitHub account.
 *
 * Two shapes, because the two deployments genuinely differ and pretending
 * otherwise would be the misleading option. With Supabase configured the
 * button starts a server-mediated OAuth flow and no credential touches the
 * browser. Without it there is no server to mediate, so the developer supplies
 * their own token and the panel says exactly where that token lives and how
 * long it survives.
 */
export function GithubConnection({ compact = false }: { compact?: boolean }) {
  const {
    status,
    account,
    scopes,
    error,
    rateLimit,
    refreshConnection,
    connectWithToken,
    beginOAuth,
    disconnect,
    clearError,
  } = useGithubStore();
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (status === 'unknown') void refreshConnection();
  }, [status, refreshConnection]);

  const connectOAuth = async () => {
    setBusy(true);
    try {
      const url = await beginOAuth();
      // Full navigation, not a popup: the callback lands on a Forge route that
      // completes the exchange server side.
      window.location.assign(url);
    } catch (caught) {
      toast.error('Could not start GitHub sign-in', errorMessage(caught));
      setBusy(false);
    }
  };

  const connectToken = async () => {
    setBusy(true);
    clearError();
    try {
      await connectWithToken(token);
      setToken('');
      toast.success('GitHub connected', useGithubStore.getState().account?.login ?? '');
    } catch (caught) {
      toast.error('GitHub rejected that token', errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  const disconnectNow = async () => {
    setBusy(true);
    try {
      await disconnect();
      toast.success('GitHub disconnected');
    } catch (caught) {
      toast.error('Could not disconnect', errorMessage(caught));
    } finally {
      setBusy(false);
    }
  };

  if (status === 'checking' || status === 'unknown') {
    return (
      <div className="flex items-center gap-2 text-base text-ink-muted">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> Checking GitHub…
      </div>
    );
  }

  if (status === 'connected' && account) {
    return (
      <div className="space-y-3">
        <div className="flex items-center gap-2.5 rounded-lg border border-line bg-surface-sunken p-3">
          {account.avatarUrl ? (
            <img
              src={account.avatarUrl}
              alt=""
              aria-hidden
              className="h-8 w-8 shrink-0 rounded-full"
            />
          ) : (
            <Github aria-hidden className="h-8 w-8 shrink-0 rounded-full p-1.5 text-ink-muted" />
          )}
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 truncate text-base text-ink">
              <CheckCircle2 aria-hidden className="h-3.5 w-3.5 shrink-0 text-positive" />
              {account.login}
            </p>
            <p className="truncate text-sm text-ink-faint">
              {isSupabaseConfigured
                ? 'Credential held server side'
                : 'Token held in this tab only'}
              {scopes.length ? ` · ${scopes.join(', ')}` : ''}
            </p>
          </div>
          <div className="flex shrink-0 gap-1.5">
            <Button size="xs" loading={busy} onClick={() => void refreshConnection()}>
              <RefreshCw aria-hidden className="h-3 w-3" />
              <span className="sr-only sm:not-sr-only">Refresh</span>
            </Button>
            <Button size="xs" loading={busy} onClick={() => void disconnectNow()}>
              <LogOut aria-hidden className="h-3 w-3" />
              Disconnect
            </Button>
          </div>
        </div>
        {rateLimit && !compact && (
          <p className="text-sm text-ink-faint">
            {rateLimit.remaining} of {rateLimit.limit} GitHub requests left this hour.
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {status === 'revoked' && (
        <p
          role="alert"
          className="flex items-start gap-2 rounded border border-caution/40 bg-caution/5 p-2.5 text-sm text-ink"
        >
          <TriangleAlert aria-hidden className="mt-0.5 h-3.5 w-3.5 shrink-0 text-caution" />
          <span>{error ?? 'GitHub access was revoked or expired. Connect again to continue.'}</span>
        </p>
      )}
      {status !== 'revoked' && error && (
        <p role="alert" className="rounded border border-danger/40 bg-danger/5 p-2.5 text-sm text-danger">
          {error}
        </p>
      )}

      {isSupabaseConfigured ? (
        <>
          <Button variant="primary" loading={busy} onClick={() => void connectOAuth()}>
            <Github aria-hidden className="h-3.5 w-3.5" />
            Connect GitHub
          </Button>
          <p className="text-sm text-ink-faint">
            You will be sent to GitHub to authorize Forge. The access token is stored on the server
            and never reaches this browser.
          </p>
        </>
      ) : (
        <>
          <Badge tone="caution">Local Development Mode</Badge>
          <p className="text-sm text-ink-muted">
            There is no Forge server in local mode, so GitHub is reached directly from this tab with
            a token you supply. It is kept in <code>sessionStorage</code> for this tab only — never
            written to disk, never put in a URL, and not available to project code or the assistant.
            Deploy with Supabase configured to move the credential server side.
          </p>
          <Input
            label="Personal access token"
            type="password"
            value={token}
            placeholder="github_pat_… or ghp_…"
            onChange={(event) => setToken(event.target.value)}
            hint="Needs the repo scope to read and push. Create one at github.com/settings/tokens."
          />
          <Button
            variant="primary"
            disabled={!token.trim() || busy}
            loading={busy}
            onClick={() => void connectToken()}
          >
            <Github aria-hidden className="h-3.5 w-3.5" />
            Connect GitHub
          </Button>
        </>
      )}
    </div>
  );
}
