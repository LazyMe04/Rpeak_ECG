/**
 * The dataset, wherever it is mounted.
 *
 * Two hosts run this app and they store the data differently:
 *
 *   * **Browser** (`npm run dev`, `npm run smoke`, the evaluator scripts): Vite
 *     middleware serves `D:\Rpeak-Desktop\data` at `/data`, so a plain `fetch`
 *     works and range requests are honoured.
 *   * **Packaged Tauri app**: there is no Node server. The Rust side exposes
 *     `read_dataset(path)` and this module calls it, so the signal files arrive
 *     as raw bytes over IPC rather than as a URL.
 *
 * Every other module asks this one, so the split exists exactly once. Adding a
 * third host (an HTTP endpoint, a file picker) means adding an arm here and
 * nothing else.
 */

/** Where the dataset is mounted in the browser. */
export const DATA_BASE = (import.meta.env.VITE_DATA_BASE as string | undefined) ?? "/data";

/**
 * True inside the Tauri webview.
 *
 * Tauri injects `__TAURI_INTERNALS__` before any application script runs, so
 * the check is safe at module load and needs no plugin call.
 */
export const IS_TAURI = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

type Invoke = (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;

let invokePromise: Promise<Invoke> | null = null;

/**
 * Load `invoke` on first use.
 *
 * A dynamic import keeps the Tauri API out of the browser bundle's initial
 * chunk; the browser path never touches it.
 */
function getInvoke(): Promise<Invoke> {
  if (!invokePromise) {
    invokePromise = import("@tauri-apps/api/core").then((m) => m.invoke as unknown as Invoke);
  }
  return invokePromise;
}

/** Strip a leading `/` or `data/` so both hosts agree on what "relative" means. */
function relative(path: string): string {
  return path.replace(/^\/+/, "").replace(/^data\//, "");
}

/**
 * Read a dataset file as bytes.
 *
 * `path` is relative to the dataset root, e.g. `catalog/f32/p00000_s00.f32`.
 * A `/data/...` or leading-slash form is accepted too, because URLs and paths
 * are passed around interchangeably elsewhere in the app.
 */
export async function readDataset(path: string): Promise<Uint8Array> {
  const rel = relative(path);

  if (IS_TAURI) {
    const invoke = await getInvoke();
    const out = await invoke("read_dataset", { path: rel });
    // Tauri v2 sends `ipc::Response` payloads as an ArrayBuffer. Accept the
    // other plausible shapes anyway: a silent mis-cast here would surface as a
    // garbage waveform rather than as an error.
    if (out instanceof ArrayBuffer) return new Uint8Array(out);
    if (out instanceof Uint8Array) return out;
    if (Array.isArray(out)) return Uint8Array.from(out as number[]);
    throw new Error(`read_dataset returned ${typeof out}, not bytes`);
  }

  const res = await fetch(`${DATA_BASE}/${rel}`);
  if (!res.ok) throw new Error(`${rel}: HTTP ${res.status}`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Read and parse a dataset JSON file. */
export async function readDatasetJson<T>(path: string): Promise<T> {
  const bytes = await readDataset(path);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
