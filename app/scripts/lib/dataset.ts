/**
 * Where the dataset lives, for every script that needs one.
 *
 * These scripts used to hard-code `D:/Rpeak-Desktop/data`, which was true on
 * exactly one machine and would have made the pre-commit hook fail forever in
 * a fresh clone -- the dataset is deliberately not in the repository, so a
 * clone has none until `pipeline/` rebuilds it. Someone cloning to
 * `C:\src\rpeak` would also have found every suite reading another checkout's
 * data, which is worse than failing: it passes on the wrong files.
 *
 * Resolution order:
 *   1. `RPEAK_DATA_DIR`, the same variable the packaged app honours
 *      (`src-tauri/src/lib.rs::resolve_root`), so one setting covers both.
 *   2. `<repo>/data`, derived from this file's own location. No cwd
 *      dependence: the hook changes directory and `npm run` does not always
 *      agree with it.
 *
 * `hasDataset()` is separate from the path on purpose. A suite that needs data
 * must ask before reading, so a machine without one reports "skipped" rather
 * than a stack trace that looks like a code defect.
 */
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The repository root: this file is `app/scripts/lib/dataset.ts`. */
export const REPO_ROOT = resolve(here, "../../..");

/** Never ends with a separator. */
export const DATA_ROOT = resolve(process.env.RPEAK_DATA_DIR ?? resolve(REPO_ROOT, "data"));

export const CATALOG = resolve(DATA_ROOT, "catalog");
export const MODELS = resolve(DATA_ROOT, "models");

/**
 * The one file every data-backed suite reads. Checking a single sentinel keeps
 * the test honest about what "has a dataset" means, instead of passing a
 * directory that exists but is empty.
 */
const SENTINEL = resolve(CATALOG, "segments/p00000_s00.ann.json");

export function hasDataset(): boolean {
  return existsSync(SENTINEL);
}

/**
 * For a suite that cannot do its work without the dataset.
 *
 * It exits 0 with a clear SKIPPED line rather than failing: the suite is not
 * broken, the machine has no data, and a red commit hook for a reason the
 * committer cannot fix (the dataset is 1.1 GB and not ours to ship) teaches
 * people to pass `--no-verify`. The caller prints the line; this only decides.
 */
export function requireDataset(script: string): boolean {
  if (hasDataset()) return true;
  console.log(`SKIPPED ${script}: no dataset at ${DATA_ROOT}`);
  console.log(`        rebuild it with pipeline/, or set RPEAK_DATA_DIR.`);
  return false;
}
