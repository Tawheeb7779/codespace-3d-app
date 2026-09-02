import { Suspense, lazy, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/authStore';
import { useTheme } from '@/hooks/useTheme';
import { ToastViewport } from '@/components/ui/Toast';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { Spinner } from '@/components/ui/Primitives';
import LandingPage from '@/routes/LandingPage';
import AuthPage from '@/routes/AuthPage';

// The IDE and dashboard pull in Monaco, xterm and the bundler; keep them out of
// the landing page's critical path.
const DashboardPage = lazy(() => import('@/routes/DashboardPage'));
const WorkspacePage = lazy(() => import('@/routes/WorkspacePage'));
const SettingsPage = lazy(() => import('@/routes/SettingsPage'));
const GithubCallbackPage = lazy(() => import('@/routes/GithubCallbackPage'));

function FullPageSpinner({ label }: { label: string }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas">
      <Spinner className="h-5 w-5" />
      <p className="text-sm text-ink-faint">{label}</p>
    </div>
  );
}

function RequireAuth({ children }: { children: React.ReactNode }) {
  const status = useAuthStore((s) => s.status);
  const location = useLocation();

  if (status === 'loading') return <FullPageSpinner label="Restoring your session…" />;
  if (status === 'anonymous') {
    return <Navigate to="/signin" replace state={{ from: location.pathname + location.search }} />;
  }
  return <>{children}</>;
}

export default function App() {
  useTheme();
  const initialize = useAuthStore((s) => s.initialize);

  useEffect(() => {
    void initialize();
  }, [initialize]);

  return (
    <ErrorBoundary area="Forge IDE">
      <Suspense fallback={<FullPageSpinner label="Loading…" />}>
        <Routes>
          <Route path="/" element={<LandingPage />} />
          <Route path="/signin" element={<AuthPage mode="signin" />} />
          <Route path="/signup" element={<AuthPage mode="signup" />} />
          <Route path="/auth/callback" element={<AuthPage mode="callback" />} />
          <Route
            path="/dashboard"
            element={
              <RequireAuth>
                <DashboardPage />
              </RequireAuth>
            }
          />
          <Route
            path="/settings"
            element={
              <RequireAuth>
                <SettingsPage />
              </RequireAuth>
            }
          />
          <Route
            path="/settings/github/callback"
            element={
              <RequireAuth>
                <GithubCallbackPage />
              </RequireAuth>
            }
          />
          <Route
            path="/project/:projectId"
            element={
              <RequireAuth>
                <WorkspacePage />
              </RequireAuth>
            }
          />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Suspense>
      <ToastViewport />
    </ErrorBoundary>
  );
}
