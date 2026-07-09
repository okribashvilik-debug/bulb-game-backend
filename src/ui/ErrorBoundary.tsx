import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  hasError: boolean;
}

const AUTO_RELOAD_DELAY_MS = 3000;

/**
 * Last-resort safety net. Without this, ANY uncaught render error anywhere
 * in the tree unmounts the whole app, leaving nothing but the page's own
 * background color — a silent blank screen with no way back short of a
 * manual refresh. This catches that instead and shows a recovery message,
 * then reloads automatically: the game is a live WebSocket connection, so a
 * full reload (fresh connect, fresh snapshot from the server) is the
 * correct recovery for any state a render error could have left behind —
 * there's nothing client-side worth preserving.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { hasError: false };

  static getDerivedStateFromError(): ErrorBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[ErrorBoundary] caught a render error, reloading shortly:', error, info.componentStack);
    setTimeout(() => window.location.reload(), AUTO_RELOAD_DELAY_MS);
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="error-boundary">
          <p>Something went wrong. Reloading…</p>
          <button className="chip-btn" onClick={() => window.location.reload()}>
            Reload now
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
