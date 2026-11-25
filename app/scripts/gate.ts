/**
 * The whole gate, in one command, stopping at the first failure.
 *
 * Before this script the answer to "is the code still good?" was fourteen
 * commands typed by hand in the right order, and three defects in this project
 * were found only because someone happened to run one of them again: a smoke
 * flake that appeared once in six runs, an exe that was never rebuilt because
 * the build wrapper exited 0, and a check that passed without asserting
 * anything. A manual gate cannot notice a flake, and a gate nobody runs notices
 * nothing.
 *
 * So this runs each stage once, stops on the first failure, and can repeat the
 * timing-sensitive stages with `--repeat N` -- a smoke suite that fails one run
 * in six is a suite whose green run means nothing.
 *
 * Usage:
 *   npm run gate                 # everything that does not need a browser
 *   npm run gate -- --browser    # plus the five CDP smoke suites
 *   npm run gate -- --repeat 3 --browser
 *   npm run gate -- --list       # what the stages are, and why each exists
 *
 * `--browser` needs a dev server on 5173 and Edge installed; `smoke:app` needs
 * the packaged exe. Those are the reasons it is not the default: a gate that
 * cannot run on a fresh clone is a gate people learn to skip.
 */
import { spawnSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { delimiter, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

import { DATA_ROOT, hasDataset } from "./lib/dataset";

const here = dirname(fileURLToPath(import.meta.url));
const APP = resolve(here, "..");
const ROOT = resolve(APP, "..");

interface Stage {
  name: string;
  /** `shell` runs through the shell so `python -I` and `npx` resolve. */
  command: string;
  args: string[];
  cwd: string;
  /** Why this stage exists, printed by --list and on failure. */
  why: string;
  /** Multiplied by --repeat. Only stages whose result is timing-dependent. */
  repeatable?: boolean;
  /** Only with --browser. */
  browser?: boolean;
  /**
   * Reads `data/`, which is deliberately not in the repository. On a clone
   * without it the stage is reported skipped rather than run: the suite would
   * print SKIPPED and exit 0 anyway, but spawning five processes to do nothing
   * and then parsing their output is a fragile way to learn what this flag
   * says directly.
   */
  dataBacked?: boolean;
  /** Extra environment for this stage, merged over the inherited one. */
  env?: Record<string, string>;
  /**
   * Why this stage cannot run here, or `null` if it can. A stage that is not
   * installed is reported by name in the footer, exactly like a data-backed one
   * with no dataset — the count never pretends it passed.
   */
  unavailable?: () => string | null;
}

const STAGES: Stage[] = [
  {
    name: "i18n audit",
    command: "python",
    args: ["-I", resolve(ROOT, "pipeline/check_i18n.py")],
    cwd: APP,
    why: "Every t() key has a Vietnamese entry, and every entry is reachable.",
  },
  {
    name: "format",
    command: "npx",
    args: [
      "prettier",
      "--check",
      "src",
      "scripts",
      "index.html",
      "vite.config.ts",
      "package.json",
      "../README.md",
      "../docs",
    ],
    cwd: APP,
    why: "The reformat happened once; this is what stops it drifting back file by file.",
  },
  {
    name: "lint",
    command: "npx",
    args: ["eslint", "src", "scripts"],
    cwd: APP,
    why: "A stale hook dependency, an effect with no cleanup, a promise nobody awaits.",
  },
  {
    name: "typecheck",
    command: "npx",
    args: ["tsc", "--noEmit"],
    cwd: APP,
    why: "The one check that catches a structural mistake before a browser does.",
  },
  {
    name: "i18n unit",
    command: "npx",
    args: ["tsx", resolve(here, "test-i18n.ts")],
    cwd: APP,
    why: "The language layer's fallbacks, placeholders and detail split.",
  },
  {
    name: "shell unit",
    command: "npx",
    args: ["tsx", resolve(here, "test-shell.ts")],
    cwd: APP,
    why: "Ring buffer, annotation index, playback arithmetic.",
  },
  {
    name: "detector unit",
    command: "npx",
    args: ["tsx", resolve(here, "test-detect.ts")],
    cwd: APP,
    why: "Every detector stage against the Python goldens.",
    dataBacked: true,
  },
  {
    name: "hrv unit",
    command: "npx",
    args: ["tsx", resolve(here, "test-hrv.ts")],
    cwd: APP,
    why: "HRV statistics against the Python reference.",
    dataBacked: true,
  },
  {
    name: "delineate unit",
    command: "npx",
    args: ["tsx", resolve(here, "test-delineate.ts")],
    cwd: APP,
    why: "PQRST timing against a synthetic golden.",
    dataBacked: true,
  },
  {
    name: "report unit",
    command: "npx",
    args: ["tsx", resolve(here, "test-report.ts")],
    cwd: APP,
    why: "The session report and both exports match the data they describe.",
    dataBacked: true,
  },
  {
    name: "cnn unit",
    command: "npx",
    args: ["tsx", resolve(here, "test-cnn.ts")],
    cwd: APP,
    why: "PyTorch logits against the TypeScript forward pass.",
    dataBacked: true,
  },
  {
    // `cargo` is not on PATH on this machine, and the data-folder precedence
    // rule is the one part of the app whose failure mode is a run that silently
    // reads the wrong dataset. It needs no dataset of its own (the tests build
    // throwaway folders), so it is not dataBacked.
    name: "rust unit",
    command: "cargo",
    args: ["test", "--quiet", "--manifest-path", resolve(APP, "src-tauri/Cargo.toml")],
    cwd: resolve(APP, "src-tauri"),
    why: "Which dataset folder wins, and which paths may be read from it.",
    env: { PATH: `${resolve(homedir(), ".cargo", "bin")}${delimiter}${process.env.PATH ?? ""}` },
    unavailable: () =>
      cargoInstalled() ? null : `no cargo on PATH or in ${resolve(homedir(), ".cargo", "bin")}`,
  },
  {
    name: "bundle",
    command: "npx",
    args: ["vite", "build"],
    cwd: APP,
    why: "The app compiles as a bundle, not only under tsc.",
  },
  {
    name: "smoke",
    command: "npx",
    args: ["tsx", resolve(here, "smoke.ts")],
    cwd: APP,
    why: "Playback, workers, boundaries and the dialog behaviour, live.",
    repeatable: true,
    browser: true,
    dataBacked: true,
  },
  {
    name: "smoke:pages",
    command: "npx",
    args: ["tsx", resolve(here, "smoke-pages.ts")],
    cwd: APP,
    why: "The model card, the guide and page navigation.",
    repeatable: true,
    browser: true,
    dataBacked: true,
  },
  {
    name: "smoke:lang",
    command: "npx",
    args: ["tsx", resolve(here, "smoke-lang.ts")],
    cwd: APP,
    why: "The shipped default is Vietnamese, and every page follows it.",
    repeatable: true,
    browser: true,
    dataBacked: true,
  },
  {
    name: "smoke:theme",
    command: "npx",
    args: ["tsx", resolve(here, "smoke-theme.ts")],
    cwd: APP,
    why: "Both palettes, measured for contrast rather than photographed.",
    repeatable: true,
    browser: true,
    dataBacked: true,
  },
  {
    name: "smoke:app",
    command: "npx",
    args: ["tsx", resolve(here, "smoke-app.ts")],
    cwd: APP,
    why: "The packaged exe, including that it was rebuilt.",
    repeatable: true,
    browser: true,
    dataBacked: true,
  },
];

const isWin = process.platform === "win32";

/**
 * `cargo` is installed here but not on PATH (it lives in `~/.cargo/bin`), so a
 * bare `existsSync` on the name is not the question. Ask the filesystem for the
 * executable in the two places it can be, and let the stage report itself
 * unavailable rather than fail with ENOENT — a missing toolchain says nothing
 * about whether the Rust tests pass.
 */
function cargoInstalled(): boolean {
  const bin = resolve(homedir(), ".cargo", "bin", isWin ? "cargo.exe" : "cargo");
  return (
    existsSync(bin) ||
    (process.env.PATH ?? "")
      .split(delimiter)
      .some((d) => existsSync(resolve(d, isWin ? "cargo.exe" : "cargo")))
  );
}

/**
 * `npx` and `python` reach the machine as `.cmd` shims, and Node cannot spawn
 * those directly: without a shell the suffix is not resolved (ENOENT), and with
 * one Node warns about unescaped arguments. `cmd /c` runs the shim as Windows
 * itself does, and the argument vector stays separate.
 */
function launch(stage: Stage): { command: string; args: string[] } {
  if (!isWin) return { command: stage.command, args: stage.args };
  return { command: process.env.COMSPEC ?? "cmd.exe", args: ["/c", stage.command, ...stage.args] };
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const has = (name: string) => process.argv.includes(name);

if (has("--list")) {
  for (const s of STAGES) {
    console.log(`${s.browser ? "browser " : "        "}${s.name.padEnd(15)} ${s.why}`);
  }
  process.exit(0);
}

const browser = has("--browser");
const repeat = Math.max(1, Number(arg("--repeat") ?? 1));

const stages = STAGES.filter((s) => browser || !s.browser);

// A gate that silently skips a stage is worse than no gate: report what was
// left out, every run, so the reader knows what green means.
const skipped = STAGES.filter((s) => !stages.includes(s));

function stamp(path: string): string {
  if (!existsSync(path)) return "missing";
  return new Date(statSync(path).mtimeMs).toISOString();
}

const exe = resolve(APP, "src-tauri/target/release/rpeak.exe");
if (browser) {
  // `smoke:app` drives whatever binary is on disk, and the packaging trap in
  // docs/packaging.md is a build that exits 0 without rebuilding. The gate
  // cannot tell from the timestamp whether the exe matches the source, but it
  // can report it, so a mismatch is visible rather than assumed.
  const newestSource = Math.max(
    ...["src/App.tsx", "src/main.tsx", "index.html", "package.json"].map((p) => {
      const f = resolve(APP, p);
      return existsSync(f) ? statSync(f).mtimeMs : 0;
    }),
  );
  const exeTime = existsSync(exe) ? statSync(exe).mtimeMs : 0;
  if (exeTime < newestSource) {
    console.log(
      `\n! rpeak.exe is older than the app sources (${stamp(exe)}).\n` +
        `  smoke:app will drive the old binary. Rebuild with:\n` +
        `  PATH="$HOME/.cargo/bin:$PATH" npx tauri build --no-bundle\n`,
    );
  }
}

console.log(`gate: ${stages.length} stages${browser ? " (+browser)" : ""}, repeat ${repeat}`);
if (skipped.length > 0) {
  console.log(`gate: not run: ${skipped.map((s) => s.name).join(", ")} (use --browser)`);
}

/**
 * A stage that did not run is not a stage that passed.
 *
 * The data-backed suites need `data/`, which is deliberately not in the
 * repository. Counting their skip as `ok` would let a green gate mean "nothing
 * was checked", which is the exact failure mode this script exists to prevent --
 * so they are named in the summary and the count is "7/13", not "all". A stage
 * whose toolchain is missing gets the same treatment, for the same reason.
 */
const haveData = hasDataset();
function notRunReason(stage: Stage): string | null {
  if (stage.dataBacked && !haveData) return `no dataset at ${DATA_ROOT}`;
  return stage.unavailable?.() ?? null;
}
const skippedBySelf = stages
  .map((s) => ({ name: s.name, why: notRunReason(s) }))
  .filter((s): s is { name: string; why: string } => s.why !== null)
  .map((s) => s.name);
if (!haveData) {
  console.log(`gate: no dataset at ${DATA_ROOT}; data-backed stages will be skipped`);
}

const t0 = Date.now();
for (const stage of stages) {
  const why = notRunReason(stage);
  if (why) {
    console.log(`\n── ${stage.name} SKIPPED (${why})`);
    continue;
  }
  const runs = stage.repeatable ? repeat : 1;
  for (let i = 0; i < runs; i++) {
    const suffix = runs > 1 ? ` (${i + 1}/${runs})` : "";
    process.stdout.write(`\n── ${stage.name}${suffix}\n`);
    const started = Date.now();
    // `shell: true` on Windows prints a deprecation warning about unescaped
    // arguments; resolving the launcher instead keeps the command explicit and
    // the argument vector intact.
    const { command, args } = launch(stage);
    const r = spawnSync(command, args, {
      cwd: stage.cwd,
      stdio: "inherit",
      env: stage.env ? { ...process.env, ...stage.env } : process.env,
    });
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    if (r.status !== 0) {
      console.error(
        `\ngate: FAILED at ${stage.name}${suffix} after ${secs}s (exit ${r.status ?? r.error}).\n` +
          `  why this stage exists: ${stage.why}\n`,
      );
      process.exit(1);
    }
    console.log(`── ${stage.name}${suffix} ok (${secs}s)`);
  }
}

const ran = stages.length - skippedBySelf.length;
if (skippedBySelf.length > 0) {
  console.log(
    `\ngate: ${ran}/${stages.length} stages ran; not run: ` +
      `${skippedBySelf.join(", ")}\n  this gate did not check those stages.`,
  );
}

console.log(
  skippedBySelf.length > 0
    ? `\ngate: ${ran}/${stages.length} stages passed in ${((Date.now() - t0) / 1000).toFixed(0)}s; ` +
        `${skippedBySelf.length} skipped (see above)`
    : `\ngate: all ${stages.length} stages passed in ${((Date.now() - t0) / 1000).toFixed(0)}s`,
);
