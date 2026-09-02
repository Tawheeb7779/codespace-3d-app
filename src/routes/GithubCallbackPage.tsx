import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { CheckCircle2, TriangleAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Primitives';
import { useGithubStore } from '@/stores/githubStore';
import { errorMessage } from '@/lib/utils';

/**
 * Where GitHub sends the user back after authorizing Forge.
 *
 * The `code` in the URL is worth nothing on its own: it is handed straight to
 * the Edge Function, which holds the client secret and performs the exchange.
 * The resulting token never travels back to this page. The URL is then
 * replaced so the one-time code does not sit in history or get shared in a
 * pasted link.
 */
export default function GithubCallbackPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const completeOAuth = useGithubStore((s) => s.completeOAuth);
  const [state, setState] = useState<'working' | 'done' | 'failed'>('working');
  const [message, setMessage] = useState('');
  const started = useRef(false);

  useEffect(() => {
    // React 18 mounts effects twice in development; a one-time code must only
    // be exchanged once, or the second attempt fails and looks like an error.
    if (started.current) return;
    started.current = true;

    const code = params.get('code');
    const oauthState = params.get('state');
    const error = params.get('error_description') ?? params.get('error');

    window.history.replaceState({}, '', '/settings/github/callback');

    if (error) {
      setState('failed');
      setMessage(error);
      return;
    }
    if (!code || !oauthState) {
      setState('failed');
      setMessage('GitHub did not return an authorization code. Start the connection again.');
      return;
    }

    completeOAuth(code, oauthState)
      .then(() => {
        setState('done');
        setTimeout(() => navigate('/settings', { replace: true }), 1200);
      })
      .catch((caught) => {
        setState('failed');
        setMessage(errorMessage(caught));
      });
  }, [params, completeOAuth, navigate]);

  return (
    <div className="flex h-full items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-sm rounded-lg border border-line bg-surface p-6 text-center">
        {state === 'working' && (
          <>
            <Spinner className="mx-auto h-5 w-5" />
            <p className="mt-3 text-base text-ink">Finishing the GitHub connection…</p>
          </>
        )}
        {state === 'done' && (
          <>
            <CheckCircle2 aria-hidden className="mx-auto h-6 w-6 text-positive" />
            <p className="mt-3 text-base text-ink">GitHub connected.</p>
            <p className="mt-1 text-sm text-ink-faint">Taking you back to settings…</p>
          </>
        )}
        {state === 'failed' && (
          <>
            <TriangleAlert aria-hidden className="mx-auto h-6 w-6 text-danger" />
            <p className="mt-3 text-base text-ink">Could not connect GitHub</p>
            <p role="alert" className="mt-1 text-sm text-ink-muted">
              {message}
            </p>
            <Button className="mt-4" onClick={() => navigate('/settings', { replace: true })}>
              Back to settings
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
