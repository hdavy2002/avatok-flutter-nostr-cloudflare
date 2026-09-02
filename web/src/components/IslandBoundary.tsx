// [WEB-POSTHOG-1] Per-island React error boundary. A hydration/render crash in
// one island must not blank the whole page (Astro islands are independent
// hydration roots, so an uncaught error here would otherwise take down just
// this island's subtree — but with no telemetry and no fallback UI, that
// showed up as silent blank space with nothing to diagnose from). This
// reports the crash and shows a small recoverable fallback card instead.
//
// Contract: Specs/SPEC-2026-09-02-TELEMETRY-CATALOG.md §1, §2.1, §2.2, §2.11.
import { Component } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { capture, captureException } from '../lib/analytics';

export interface IslandBoundaryProps {
  /** Short, stable island name — matches the catalog's `island` property. */
  island: string;
  children: ReactNode;
}

interface IslandBoundaryState {
  hasError: boolean;
}

export class IslandBoundary extends Component<IslandBoundaryProps, IslandBoundaryState> {
  state: IslandBoundaryState = { hasError: false };

  static getDerivedStateFromError(): IslandBoundaryState {
    return { hasError: true };
  }

  componentDidCatch(err: unknown, info: ErrorInfo): void {
    const { island } = this.props;
    captureException(err, {
      island,
      component_stack: info.componentStack?.slice(0, 800),
    });
    capture('island_hydrate_error', {
      island,
      message: err instanceof Error ? err.message : String(err),
    });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="rounded-zine-field border-zine border-ink bg-card px-4 py-5 font-body text-ink shadow-zine-xs">
          <p className="font-bold text-[15px]">Kuch gadbad ho gayi — reload karke dekho.</p>
          <button
            type="button"
            onClick={() => window.location.reload()}
            className="mt-3 rounded-zine-badge border-zine border-ink bg-ink px-4 py-2 font-mono font-bold uppercase text-[13px] tracking-[0.06em] text-paper shadow-zine-xs active:translate-x-[1px] active:translate-y-[1px]"
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default IslandBoundary;
