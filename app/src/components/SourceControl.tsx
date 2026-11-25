import { useCallback, useEffect, useState } from "react";
import { useT } from "../lib/i18n";
import {
  chooseSource,
  describeSource,
  originLabel,
  resetSource,
  sourceNotice,
  type DataSource,
} from "../lib/source";

/**
 * The folder the app reads its dataset from: where it is, why, and the two ways
 * to change it.
 *
 * In the browser there is no Rust side to ask, so the dev server answers
 * instead — read-only, because the browser's root is fixed when Vite starts.
 * That asymmetry is the honest one: the packaged app can be repointed from
 * inside it, the dev server cannot, and the component says so rather than
 * offering a button that would do nothing.
 */

/** What `GET /__data-root` returns from the dev server. */
interface DevRoot {
  path: string;
  origin: string;
}

function useSource(): {
  src: DataSource | null;
  dev: DevRoot | null;
  refresh: () => Promise<void>;
} {
  const [src, setSrc] = useState<DataSource | null>(null);
  const [dev, setDev] = useState<DevRoot | null>(null);

  const refresh = useCallback(async () => {
    const native = await describeSource();
    if (native) {
      setSrc(native);
      return;
    }
    // The browser. A packaged build has no middleware either, but there the
    // native arm above always answers, so a failure here just means "unknown".
    try {
      const res = await fetch("/__data-root");
      if (res.ok) setDev((await res.json()) as DevRoot);
    } catch {
      /* no dev server: nothing to say */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { src, dev, refresh };
}

/**
 * Reload the page on the new folder.
 *
 * A switch is not a hot swap: the open segment, its annotations and every
 * worker result belong to the folder they were read from. Reloading is the only
 * way to be sure nothing computed against the old dataset is on screen. The
 * URL keeps its page and language and loses the segment, which does not exist
 * in the new folder yet.
 */
function reloadOnto() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("record");
    url.searchParams.delete("t");
    window.history.replaceState(null, "", url);
  } catch {
    /* history is best-effort */
  }
  window.location.reload();
}

export function SourceControl({ compact = false }: { compact?: boolean }) {
  const { t } = useT();
  const { src, dev, refresh } = useSource();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (op: () => Promise<DataSource | null>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await op();
      // `null` means cancelled, or a switch this host cannot make.
      if (next) reloadOnto();
      else await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const path = src?.path ?? dev?.path ?? null;
  // A native source's origin is a word this app owns and translates; the dev
  // server's is already a sentence it wrote, and one of the two is a variable
  // name (`RPEAK_DATA_DIR`) that must not go through the dictionary.
  const origin = src ? t(originLabel(src.origin)) : (dev?.origin ?? null);
  const notice = src ? sourceNotice(src) : null;

  return (
    <div
      className={`${compact ? "" : "mb-3"} rounded-lg border border-[var(--border)] px-2.5 py-2`}
      data-testid="data-source"
    >
      <div className="text-[11px] uppercase tracking-wider text-faint mb-1">
        {t("Dataset folder")}
      </div>

      {path ? (
        <div className="mono text-[11px] text-dim break-all" data-testid="data-source-path">
          {path}
        </div>
      ) : (
        <div className="text-[11px] text-faint">{t("unknown")}</div>
      )}

      {origin && (
        <div className="text-[11px] text-faint mt-1" data-testid="data-source-origin">
          {origin}
        </div>
      )}

      {src && src.warnings.length > 0 && (
        <div className="text-[11px] text-yellow-400 mt-1">
          {t("Missing from this folder: {files}", { files: src.warnings.join(", ") })}
        </div>
      )}

      {notice && (
        <div className="text-[11px] text-yellow-400 mt-1" data-testid="data-source-notice">
          {t(notice, { path: src?.remembered ?? "" })}
        </div>
      )}

      {error && <div className="text-[11px] text-red-400 mt-1 break-words">{error}</div>}

      {src ? (
        <div className="flex flex-wrap gap-1.5 mt-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(chooseSource)}
            className="icon-btn px-2 py-1 text-[11px]"
            data-testid="choose-source"
          >
            {t("Choose folder…")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void run(resetSource)}
            className="icon-btn px-2 py-1 text-[11px]"
            data-testid="reset-source"
          >
            {t("Use default")}
          </button>
        </div>
      ) : (
        <div className="text-[11px] text-faint mt-1">
          {t("The dev server reads this folder; restart it with RPEAK_DATA_DIR to change it.")}
        </div>
      )}
    </div>
  );
}
