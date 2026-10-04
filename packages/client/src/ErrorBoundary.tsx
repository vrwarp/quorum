import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';

/** Keeps a rendering failure to the screen it happened on: a message and a way back, not a blank page. */
export class ErrorBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Quorum could not render this screen', error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="center-screen" role="alert" data-testid="error-boundary">
        <div className="stack">
          <p>Something went wrong showing this page.</p>
          <button type="button" className="btn primary" onClick={() => location.reload()}>
            Reload
          </button>
        </div>
      </div>
    );
  }
}
