import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, Hammer, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Spinner } from '@/components/ui/Primitives';
import { useAuthStore } from '@/stores/authStore';
import { useProjectStore } from '@/stores/projectStore';
import { repositoryFor } from '@/lib/repo';
import { tokenFromFragment } from '@/lib/invitations';
import { errorMessage } from '@/lib/utils';

/**
 * Redeeming an invitation link.
 *
 * The token arrives in the URL fragment, which browsers never send to a
 * server — so it stays out of access logs and `Referer` headers. It is read
 * once, exchanged for membership, and then removed from the address bar so a
 * screenshot or a shared URL cannot carry it further.
 *
 * Redemption needs an account, because membership references one. Signing in
 * first is therefore a step, not a failure, and the page says so rather than
 * reporting the invitation as broken.
 */

type Status = 'reading' | 'needs-account' | 'accepting' | 'accepted' | 'failed';

export default function InvitePage() {
  const navigate = useNavigate();
  const user = useAuthStore((s) => s.user);
  // Session restoration runs on load; redeeming before it settles would
  // read the user as absent and send them to sign in unnecessarily.
  const restoring = useAuthStore((s) => s.status === 'loading');

  const [status, setStatus] = useState<Status>('reading');
  const [detail, setDetail] = useState('');
  const tokenRef = useRef<string | null>(null);
  const attempted = useRef(false);

  // Read the fragment once, before anything can rewrite the URL.
  useEffect(() => {
    tokenRef.current = tokenFromFragment(window.location.hash);
    if (!tokenRef.current) {
      setStatus('failed');
      setDetail('That invitation link is not valid. Ask for a new one.');
    }
  }, []);

  useEffect(() => {
    if (!tokenRef.current || restoring || attempted.current) return;
    if (!user) {
      setStatus('needs-account');
      return;
    }

    attempted.current = true;
    setStatus('accepting');
    const token = tokenRef.current;
    // Clear it from the address bar before the request resolves, so the token
    // is not sitting in history if the user navigates away mid-flight.
    window.history.replaceState(null, '', '/invite');

    repositoryFor(user.provider)
      .acceptInvitation(token)
      .then(async (projectId) => {
        setStatus('accepted');
        await useProjectStore.getState().load();
        navigate(`/project/${projectId}`, { replace: true });
      })
      .catch((error) => {
        setStatus('failed');
        setDetail(errorMessage(error));
      });
  }, [user, restoring, navigate]);

  return (
    <div className="flex h-full items-center justify-center bg-canvas p-6">
      <div className="w-full max-w-md text-center">
        <span className="mx-auto mb-4 flex h-9 w-9 items-center justify-center rounded bg-accent text-accent-ink">
          <Hammer aria-hidden className="h-4 w-4" />
        </span>

        {(status === 'reading' || status === 'accepting') && (
          <>
            <Spinner className="mx-auto h-5 w-5" />
            <p className="mt-3 text-base text-ink-muted">
              {status === 'reading' ? 'Checking your invitation…' : 'Joining the project…'}
            </p>
          </>
        )}

        {status === 'needs-account' && (
          <>
            <h1 className="text-lg font-semibold text-ink">Sign in to accept</h1>
            <p className="mt-2 text-base text-ink-muted">
              An invitation is tied to an account, so we need you signed in with the address it
              was sent to. Your link stays valid.
            </p>
            <Button
              variant="primary"
              className="mt-4"
              onClick={() =>
                navigate(`/signin?next=${encodeURIComponent(`/invite${window.location.hash}`)}`)
              }
            >
              Sign in
            </Button>
          </>
        )}

        {status === 'accepted' && (
          <>
            <CheckCircle2 aria-hidden className="mx-auto h-6 w-6 text-positive" />
            <h1 className="mt-2 text-lg font-semibold text-ink">You&rsquo;re in</h1>
            <p className="mt-1 text-base text-ink-muted">Opening the project…</p>
          </>
        )}

        {status === 'failed' && (
          <>
            <XCircle aria-hidden className="mx-auto h-6 w-6 text-danger" />
            <h1 className="mt-2 text-lg font-semibold text-ink">This invitation cannot be used</h1>
            <p className="mt-2 text-base text-ink-muted">{detail}</p>
            <p className="mt-2 text-sm text-ink-faint">
              Invitations work once, expire after seven days, and only for the address they were
              sent to.
            </p>
            <Button className="mt-4" onClick={() => navigate('/dashboard')}>
              Go to your projects
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
