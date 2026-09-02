import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertOctagon } from 'lucide-react';
import { Button } from '@/components/ui/Button';

interface Props {
  children: ReactNode;
  /** Shown in the fallback so the user knows which area failed. */
  area?: string;
}

interface State {
  error: Error | null;
  stack: string;
}

/**
 * Catches render errors so one broken panel cannot blank the whole IDE. The
 * message and component stack are shown verbatim — a developer tool should
 * hand you the real error, not "something went wrong".
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: '' };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[forge] render error', error, info.componentStack);
    this.setState({ stack: info.componentStack ?? '' });
  }

  render() {
    const { error, stack } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="flex h-full w-full items-center justify-center overflow-auto p-6">
        <div className="w-full max-w-xl rounded-lg border border-danger/40 bg-danger/5 p-4">
          <div className="flex items-center gap-2 text-danger">
            <AlertOctagon className="h-4 w-4" />
            <h2 className="text-md font-semibold">
              {this.props.area ? `${this.props.area} crashed` : 'This view crashed'}
            </h2>
          </div>
          <p className="mt-2 break-words font-mono text-sm text-ink">{error.message}</p>
          {stack && (
            <pre className="scrollbar-thin mt-3 max-h-48 overflow-auto rounded border border-line bg-surface-sunken p-2 font-mono text-xs text-ink-muted">
              {stack.trim()}
            </pre>
          )}
          <div className="mt-3 flex gap-2">
            <Button variant="primary" size="sm" onClick={() => this.setState({ error: null, stack: '' })}>
              Try again
            </Button>
            <Button size="sm" onClick={() => window.location.reload()}>
              Reload the app
            </Button>
          </div>
        </div>
      </div>
    );
  }
}
