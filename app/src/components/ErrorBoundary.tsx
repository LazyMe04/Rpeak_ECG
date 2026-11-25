/**
 * The last line of defence: a panel that throws must not take the window.
 *
 * React unmounts the whole tree when a render throws and no boundary catches
 * it. In a browser tab that is annoying; in the packaged app it is a dead end,
 * because there is no address bar to reload from and no Vite overlay to say
 * what happened -- the window simply goes blank, which is indistinguishable
 * from a hang.
 *
 * So each panel gets its own boundary and the page root gets another. The
 * panel-level one is deliberately scoped: a classifier that cannot read its
 * model should cost the reader that panel, not the trace they were reading.
 *
 * It is a class because React has no hook for this -- `componentDidCatch` is
 * the only supported hook, and it has no function-component equivalent.
 *
 * The error text is shown as written. It is a JavaScript message, like the
 * worker diagnostics `td()` leaves alone, not a sentence of ours to translate.
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { translate, type Lang } from "../lib/i18n";

interface Props {
  children: ReactNode;
  /** What failed, for the heading: "the vitals panel". */
  what: string;
  /**
   * The language, passed in rather than read from context.
   *
   * A boundary renders *above* the thing that threw, so it may itself be
   * inside `LocaleProvider` -- but if the throw came from the provider's own
   * subtree, reading `useT()` here could fail again. Taking the language as a
   * prop keeps this component free of hooks and safe to use anywhere.
   */
  lang: Lang;
  /**
   * Remount the children instead of leaving the fallback in place. A panel
   * whose failure was transient (a worker that died mid-run) can be retried;
   * the boundary cannot know that, so the reader decides.
   */
  onRetry?: () => void;
  /**
   * `panel` floats over a dashboard that is still usable; `full` takes the
   * whole window, for the root boundary where there is nothing left behind it.
   */
  variant?: "panel" | "full";
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // In a release build this is the only record: there is no console anyone
    // can open from a packaged WebView2 window. Keep it in one line so a
    // screenshot of DevTools is enough to file a bug.
    console.error(`[rpeak] ${this.props.what} threw:`, error, info.componentStack);
  }

  private retry = (): void => {
    this.setState({ error: null });
    this.props.onRetry?.();
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    const t = (en: string, vars?: Record<string, string | number>) =>
      translate(this.props.lang, en, vars);
    const full = this.props.variant === "full";
    return (
      <div
        className={
          full
            ? "absolute inset-0 z-50 flex items-center justify-center p-4"
            : "absolute inset-x-4 top-20 z-40 flex justify-center pointer-events-none"
        }
      >
        <div
          className={`panel px-5 py-4 w-full max-w-md text-center border-red-500/40 ${
            full ? "" : "pointer-events-auto"
          }`}
        >
          <div className="text-red-400 font-semibold mb-1">
            {full ? t("The app stopped working") : t("This panel stopped working")}
          </div>
          <div className="text-xs text-dim mb-2">
            {full
              ? t("Something in the app threw while drawing. Reloading usually clears it.")
              : t("{what} hit an error while drawing. The rest of the app keeps running.", {
                  what: t(this.props.what),
                })}
          </div>
          {/* The message is the runtime's, not ours: it stays as thrown. */}
          <div className="mono text-[11px] text-faint break-words mb-3">
            {error.message || String(error)}
          </div>
          <button type="button" onClick={this.retry} className="icon-btn px-3 py-1.5 text-xs">
            {full ? t("Reload") : t("Try again")}
          </button>
        </div>
      </div>
    );
  }
}

/**
 * A component that throws on demand, for the smoke test.
 *
 * A boundary nobody has watched catch anything is a guess. Proving it in a
 * release build is impossible without a fault injector, and in a dev build the
 * Vite overlay would catch the error first if it were uncaught -- so the probe
 * is a real React subtree, mounted into a panel, that throws on a flag. The
 * smoke script sets the flag and asserts the fallback, which is the only
 * evidence that the boundary is wired in the right place.
 *
 * Kept out of the production bundle by the caller: `App` only renders it under
 * `import.meta.env.DEV`.
 */
export function FaultProbe({ when }: { when: boolean }): ReactNode {
  if (when) throw new Error("fault probe: a deliberate render error");
  // `sr-only` rather than a visible div: the probe is armed for the whole dev
  // session, and a debug label sitting in the corner of every screenshot is
  // how it ends up in the README.
  return (
    <div data-fault-probe className="sr-only">
      fault probe armed
    </div>
  );
}
