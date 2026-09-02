import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { AlertCircle, Github, Hammer, Loader2, Mail } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Field';
import { Badge } from '@/components/ui/Primitives';
import { useAuthStore } from '@/stores/authStore';
import { isSupabaseConfigured, supabaseConfigDetail } from '@/lib/supabase';

interface AuthPageProps {
  mode: 'signin' | 'signup' | 'callback';
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className="h-3.5 w-3.5">
      <path
        fill="currentColor"
        d="M21.35 11.1H12v2.9h5.35c-.23 1.4-1.63 4.1-5.35 4.1-3.22 0-5.85-2.67-5.85-5.95S8.78 6.2 12 6.2c1.83 0 3.06.78 3.76 1.45l2.56-2.47C16.66 3.6 14.53 2.7 12 2.7 6.98 2.7 2.9 6.78 2.9 11.8S6.98 20.9 12 20.9c5.5 0 9.13-3.87 9.13-9.32 0-.62-.07-1.1-.18-1.48Z"
      />
    </svg>
  );
}

export default function AuthPage({ mode }: AuthPageProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { status, error, busy, signIn, signUp, signInWithOAuth, signInLocally, clearError } =
    useAuthStore();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [localBusy, setLocalBusy] = useState(false);

  const redirectTo = (location.state as { from?: string } | null)?.from ?? '/dashboard';

  useEffect(() => {
    clearError();
  }, [mode, clearError]);

  useEffect(() => {
    if (status === 'authenticated') navigate(redirectTo, { replace: true });
  }, [status, navigate, redirectTo]);

  if (mode === 'callback') {
    if (status === 'authenticated') return <Navigate to="/dashboard" replace />;
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-canvas">
        {status === 'loading' ? (
          <>
            <Loader2 className="h-5 w-5 animate-spin text-accent" />
            <p className="text-base text-ink-muted">Completing sign in…</p>
          </>
        ) : (
          <>
            <AlertCircle className="h-5 w-5 text-danger" />
            <p className="text-base text-ink">Sign in did not complete.</p>
            <p className="max-w-sm text-center text-sm text-ink-faint">
              {error ?? 'The provider did not return a session. Try again from the sign-in page.'}
            </p>
            <Link to="/signin">
              <Button size="sm">Back to sign in</Button>
            </Link>
          </>
        )}
      </div>
    );
  }

  const isSignup = mode === 'signup';

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    try {
      if (isSignup) await signUp(email, password, displayName);
      else await signIn(email, password);
    } catch {
      // The store holds the message; the form stays put so it can be shown.
    }
  };

  const onLocal = async () => {
    setLocalBusy(true);
    try {
      await signInLocally(displayName || 'Local Developer');
    } finally {
      setLocalBusy(false);
    }
  };

  return (
    <div className="grid h-full grid-cols-1 overflow-y-auto bg-canvas lg:grid-cols-2">
      {/* Brand rail */}
      <aside className="relative hidden flex-col justify-between border-r border-line p-10 lg:flex">
        <div aria-hidden className="pointer-events-none absolute inset-0 grid-backdrop" />
        <Link to="/" className="relative flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded bg-accent text-accent-ink">
            <Hammer className="h-3.5 w-3.5" />
          </span>
          <span className="text-md font-semibold text-ink">Forge</span>
        </Link>
        <div className="relative max-w-sm">
          <h2 className="text-2xl font-semibold text-ink">
            Your workspace, one tab away
          </h2>
          <p className="mt-3 text-md text-ink-muted">
            Editor, terminal, bundler, version control and preview — all running client side, all
            doing real work.
          </p>
        </div>
        <p className="relative text-sm text-ink-faint">
          {isSupabaseConfigured
            ? 'Sessions are managed by Supabase Auth with PKCE.'
            : 'No Supabase credentials found. Local Development Mode is available below.'}
        </p>
      </aside>

      {/* Form */}
      <main className="flex items-center justify-center px-4 py-12 sm:px-8">
        <div className="w-full max-w-sm">
          <Link to="/" className="mb-8 flex items-center gap-2 lg:hidden">
            <span className="flex h-6 w-6 items-center justify-center rounded bg-accent text-accent-ink">
              <Hammer className="h-3.5 w-3.5" />
            </span>
            <span className="text-md font-semibold text-ink">Forge</span>
          </Link>

          <h1 className="text-xl font-semibold text-ink">
            {isSignup ? 'Create your account' : 'Sign in to Forge'}
          </h1>
          <p className="mt-1.5 text-base text-ink-muted">
            {isSignup
              ? 'Projects, settings and version history follow your account.'
              : 'Pick up where you left off.'}
          </p>

          {!isSupabaseConfigured && (
            <div className="mt-5 rounded-lg border border-caution/30 bg-caution/5 p-3">
              <Badge tone="caution">Local Development Mode</Badge>
              <p className="mt-2 text-sm text-ink-muted">
                Supabase is not configured, so email and OAuth sign-in are unavailable. Continue
                locally and your projects will be stored in this browser only.
              </p>
              {/*
                Name the specific reason. "Not configured" is true for a missing
                variable, a malformed URL and a rejected service-role key alike,
                and an operator staring at a typo needs to know which.
              */}
              <p className="mt-1.5 font-mono text-xs text-ink-faint">{supabaseConfigDetail}</p>
              <Button
                variant="primary"
                size="sm"
                block
                className="mt-3"
                loading={localBusy}
                onClick={onLocal}
              >
                Continue in Local Mode
              </Button>
            </div>
          )}

          <form onSubmit={onSubmit} className="mt-6 space-y-4">
            {isSignup && (
              <Input
                label="Display name"
                autoComplete="name"
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                placeholder="Ada Lovelace"
                disabled={!isSupabaseConfigured}
              />
            )}
            <Input
              label="Email"
              type="email"
              required
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              placeholder="you@example.com"
              leading={<Mail className="h-3.5 w-3.5" />}
              disabled={!isSupabaseConfigured}
            />
            <Input
              label="Password"
              type="password"
              required
              minLength={8}
              autoComplete={isSignup ? 'new-password' : 'current-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              hint={isSignup ? 'At least 8 characters.' : undefined}
              disabled={!isSupabaseConfigured}
            />

            {error && (
              <div role="alert" className="flex gap-2 rounded border border-danger/40 bg-danger/5 p-2.5">
                <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" />
                <p className="text-sm text-ink">{error}</p>
              </div>
            )}

            <Button
              type="submit"
              variant="primary"
              size="lg"
              block
              loading={busy}
              disabled={!isSupabaseConfigured}
            >
              {isSignup ? 'Create account' : 'Sign in'}
            </Button>
          </form>

          <div className="my-6 flex items-center gap-3">
            <span className="h-px flex-1 bg-line" />
            <span className="text-xs uppercase tracking-wider text-ink-faint">or</span>
            <span className="h-px flex-1 bg-line" />
          </div>

          <div className="grid gap-2">
            <Button
              size="lg"
              leading={<GoogleMark />}
              disabled={!isSupabaseConfigured || busy}
              onClick={() => void signInWithOAuth('google').catch(() => undefined)}
            >
              Continue with Google
            </Button>
            <Button
              size="lg"
              leading={<Github className="h-3.5 w-3.5" />}
              disabled={!isSupabaseConfigured || busy}
              onClick={() => void signInWithOAuth('github').catch(() => undefined)}
            >
              Continue with GitHub
            </Button>
          </div>

          {!isSupabaseConfigured && (
            <p className="mt-3 text-sm text-ink-faint">
              OAuth providers need Supabase. See the README for the two environment variables.
            </p>
          )}

          <p className="mt-8 text-center text-base text-ink-muted">
            {isSignup ? 'Already have an account?' : 'New to Forge?'}{' '}
            <Link
              to={isSignup ? '/signin' : '/signup'}
              className="font-medium text-accent hover:underline"
            >
              {isSignup ? 'Sign in' : 'Create one'}
            </Link>
          </p>
        </div>
      </main>
    </div>
  );
}
