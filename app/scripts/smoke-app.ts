/**
 * Smoke-test the *packaged* app, not the browser build.
 *
 * `smoke.ts` proves the Vite app works against the middleware that serves
 * `data/`. That says nothing about the thing G6 ships: a .exe with no Node
 * server, where the dataset arrives over IPC and every path resolution is
 * different. A build that compiles and a window that opens is not evidence that
 * a segment loaded — the failure mode is a window that renders its chrome and
 * then says "Cannot load the dataset", which looks perfectly healthy in a
 * screenshot taken too early.
 *
 * So this drives the real executable over the WebView2 DevTools protocol and
 * asserts what the DOM says. It cannot use `window.__rpeak`: that handle is
 * compiled out of release builds, which is exactly what is under test. The one
 * exception is the dataset-folder checks, which call `__TAURI_INTERNALS__.invoke`
 * directly — that is Tauri's own bridge, present in every build, not ours.
 *
 * Usage:
 *   npx tauri build --no-bundle
 *   npx tsx scripts/smoke-app.ts [--exe path/to/rpeak.exe] [--shot out.png]
 */
import { spawn } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { DATA_ROOT, MODELS } from "./lib/dataset";

const here = dirname(fileURLToPath(import.meta.url));
const CDP_PORT = 9444;

/**
 * A number that can only come from the model artefact, derived rather than
 * copied: the packaged app reads the same `data/models/beatcnn.json`, so a
 * literal here would go stale on the next retrain and fail for the wrong reason.
 */
function storedParamCount(): string {
  const model = JSON.parse(readFileSync(resolve(MODELS, "beatcnn.json"), "utf8"));
  const n =
    model.blocks.reduce(
      (s: number, b: { conv: { w: number[][][]; b: number[] } }) =>
        s + b.conv.w.length * b.conv.w[0]!.length * b.conv.w[0]![0]!.length + b.conv.b.length,
      0,
    ) +
    model.head.reduce(
      (s: number, l: { w: number[][]; b: number[] }) =>
        s + l.w.length * l.w[0]!.length + l.b.length,
      0,
    );
  return n.toLocaleString("en-US");
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
}

const EXE = resolve(here, arg("--exe", "../src-tauri/target/release/rpeak.exe"));
const SHOT = arg("--shot", "");
// A release build only looks beside the exe for `data/`, which is the right
// behaviour for a shipped app and useless for a test run against the repo.
// Point it at the resolved dataset unless the caller says otherwise, so
// `RPEAK_DATA_DIR` reaches the exe the same way it reaches every other script.
const DATA_DIR = resolve(here, arg("--data", DATA_ROOT));
// Set by `--no-data-env`, which is how the portable layout is tested: the app
// must find `data/` beside its own executable without being told.
const NO_DATA_ENV = process.argv.includes("--no-data-env");

/**
 * The trimmed dataset the source-switching checks use: one segment instead of
 * 24, 4.6 MB instead of 1.1 GB, in a folder whose name is Vietnamese so a
 * non-ASCII path is exercised too.
 *
 * Built from `DATA_DIR` on first use rather than committed: `.cache/` is
 * gitignored, and a fixture checked in would be a second copy of the dataset
 * that drifts from it. The catalogue is cut to one entry and the rest of the
 * files are copied, so the folder passes the same `catalog/segments.json` test
 * every real dataset passes.
 */
const FIXTURE = resolve(here, "../../.cache/dữ liệu thử");

function ensureFixture(): void {
  if (existsSync(resolve(FIXTURE, "catalog/segments.json"))) return;
  const all = JSON.parse(readFileSync(resolve(DATA_DIR, "catalog/segments.json"), "utf8")) as {
    record: string;
  }[];
  const one = all[0];
  if (!one) throw new Error(`${DATA_DIR} has no segments to trim`);
  for (const d of ["catalog/segments", "catalog/f32", "models"]) {
    mkdirSync(resolve(FIXTURE, d), { recursive: true });
  }
  writeFileSync(resolve(FIXTURE, "catalog/segments.json"), JSON.stringify([one]));
  copyFileSync(
    resolve(DATA_DIR, `catalog/segments/${one.record}.ann.json`),
    resolve(FIXTURE, `catalog/segments/${one.record}.ann.json`),
  );
  copyFileSync(
    resolve(DATA_DIR, `catalog/f32/${one.record}.f32`),
    resolve(FIXTURE, `catalog/f32/${one.record}.f32`),
  );
  copyFileSync(resolve(DATA_DIR, "models/beatcnn.json"), resolve(FIXTURE, "models/beatcnn.json"));
  console.log(`  note  built the trimmed fixture at ${FIXTURE}`);
}
/**
 * Where the app remembers a chosen folder. Identical to Rust's
 * `app_config_dir()/source.json`; the checks delete it so they can never pass
 * on a previous run's leftovers.
 */
const CONFIG = resolve(process.env.APPDATA ?? "", "com.rpeak.desktop", "source.json");

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Cdp {
  send(method: string, params?: unknown): Promise<any>;
  close(): void;
}

async function connect(wsUrl: string): Promise<Cdp> {
  const ws = new WebSocket(wsUrl);
  await new Promise<void>((res, rej) => {
    ws.addEventListener("open", () => res(), { once: true });
    ws.addEventListener("error", () => rej(new Error("CDP socket failed")), { once: true });
  });

  let id = 0;
  const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data)) as {
      id?: number;
      result?: unknown;
      error?: { message: string };
    };
    if (msg.id == null) return;
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.rej(new Error(msg.error.message));
    else p.res(msg.result);
  });

  return {
    send(method, params) {
      const myId = ++id;
      return new Promise((res, rej) => {
        pending.set(myId, { res, rej });
        ws.send(JSON.stringify({ id: myId, method, params }));
      });
    },
    close() {
      ws.close();
    },
  };
}

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) console.log(`  ok   ${name}`);
  else {
    failures++;
    console.log(`  FAIL ${name}${detail ? ` -- ${detail}` : ""}`);
  }
}

/** One launched app, attached to its page and ready to evaluate. */
interface Session {
  evaluate(expr: string): Promise<any>;
  cdp: Cdp;
  stderr(): string;
  stop(): void;
}

async function launch(env: Record<string, string | undefined>): Promise<Session> {
  const app = spawn(EXE, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  app.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });

  let wsUrl = "";
  for (let i = 0; i < 120 && !wsUrl; i++) {
    await sleep(250);
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = (await res.json()) as {
        type: string;
        webSocketDebuggerUrl: string;
        url: string;
      }[];
      const page = list.find((t) => t.type === "page");
      if (page) wsUrl = page.webSocketDebuggerUrl;
    } catch {
      /* not up yet */
    }
  }
  if (!wsUrl) {
    app.kill();
    throw new Error(`could not attach to the app window. stderr:\n${stderr}`);
  }

  const cdp = await connect(wsUrl);
  await cdp.send("Runtime.enable");

  return {
    cdp,
    stderr: () => stderr,
    evaluate: async (expr) => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "evaluate threw");
      return r.result.value;
    },
    stop() {
      cdp.close();
      app.kill();
    },
  };
}

/** Wait for a condition that the page evaluates, polling. */
async function poll(
  evaluate: (expr: string) => Promise<any>,
  expr: string,
  tries = 80,
  wait = 250,
): Promise<any> {
  let last: any = null;
  for (let i = 0; i < tries; i++) {
    last = await evaluate(expr).catch(() => null);
    if (last) return last;
    await sleep(wait);
  }
  return last;
}

async function main(): Promise<void> {
  if (!existsSync(EXE)) {
    throw new Error(`no packaged app at ${EXE}; run \`npx tauri build --no-bundle\``);
  }
  console.log(`app ${EXE}`);
  console.log(`data ${NO_DATA_ENV ? "(resolved by the app)" : DATA_DIR}`);

  const baseEnv: Record<string, string | undefined> = {
    ...process.env,
    // WebView2 forwards these to its Chromium instance.
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
  };
  if (NO_DATA_ENV) delete baseEnv.RPEAK_DATA_DIR;
  else baseEnv.RPEAK_DATA_DIR = DATA_DIR;

  const app = await launch(baseEnv);

  try {
    const { evaluate } = app;

    if (!NO_DATA_ENV) ensureFixture();
    // Start from "no choice has ever been made", so none of the checks below
    // can pass on a folder a previous run remembered.
    rmSync(CONFIG, { force: true });
    const fullCount = (
      JSON.parse(readFileSync(resolve(DATA_DIR, "catalog/segments.json"), "utf8")) as unknown[]
    ).length;

    // The app ships in Vietnamese; every assertion below looks for an English
    // label ("AI Beat Classifier", "Rpeak — User Guide"). Rather than duplicate
    // each one, switch the packaged build to English through the same control a
    // reader uses -- which also proves the switch renders and works here, where
    // there is no dev handle and no `?lang=` to lean on.
    //
    // The window keeps its WebView2 profile between runs, so a previous run that
    // left "en" stored would make "starts in Vietnamese" fail on the second
    // invocation and pass on the first. Clear it and reload, then read the
    // default a first-time reader would get.
    //
    // The reload is the trap: `location.reload()` returns immediately and the
    // old document stays live until the new one commits. The old document also
    // has a language switch and a `lang` attribute, so a poll for those reads
    // the *previous* run's "en" and reports it as the shipped default — a
    // failure that appears once in three runs. A token set before the reload
    // and required to be gone afterwards is what distinguishes the new document
    // from the old one; the same fix as `smoke-lang`'s navigation token.
    // The reset must happen *after* the app has mounted, or it undoes itself:
    // `index.html` ships `<html lang="en">`, so a poll that waits only for a
    // non-empty `lang` fires before React exists, `removeItem` runs against a
    // provider that has not mounted yet, and the mount effect immediately
    // writes "en" back. The proof that the effect has run is that the attribute
    // agrees with what is stored — `storedLang()` is what the provider chose, so
    // a mismatch means the write is still pending. This was measured: with the
    // weaker condition, one run in three read `stored: "en"` on a profile that
    // had been reset.
    const cleared = await poll(
      evaluate,
      `(() => {
        if (!document.body) return false;
        if (!document.querySelector("[data-lang-switch]")) return false;
        let stored = null;
        try { stored = localStorage.getItem("rpeak.lang"); } catch { return false; }
        // Absent storage means the provider fell back to the shipped default,
        // which is Vietnamese.
        const expected = stored === "en" || stored === "vi" ? stored : "vi";
        if (document.documentElement.lang !== expected) return false;
        try { localStorage.removeItem("rpeak.lang"); } catch { return false; }
        window.__navToken = "reload";
        location.reload();
        return true;
      })()`,
      // A cold WebView2 start can take a while to mount on a loaded machine;
      // the default of 80 × 250 ms was fine, the longer poll is not the point.
      80,
    );
    if (!cleared) throw new Error("the app never mounted, so the default cannot be read");

    // Two ways to read the wrong document, both seen on this machine: the
    // reload returns before the new document commits, and inside the new one
    // the switch renders a commit before `LocaleProvider`'s effect writes
    // `document.documentElement.lang` — `index.html` ships `lang="en"`, so that
    // gap reads English on a page about to become Vietnamese. The token rejects
    // the old document. Polling until `lang === "vi"` would be wrong for the
    // second gap: an app that really shipped in English would never match, the
    // poll would exhaust, and the failure would land on "offers the language
    // switch" rather than on the default that is actually wrong. So the loop
    // below waits for the reading to stop changing and reports what it settled
    // on; the assertions decide.
    let settled: { lang?: string; vi?: string } | null = null;
    let previous = "";
    for (let i = 0; i < 60 && !settled; i++) {
      const now = (await evaluate(`(() => {
        // A document that still carries the token is the one that asked for the
        // reload, not the one it produced.
        if ("__navToken" in window) return "";
        if (!document.querySelector("[data-lang-switch]")) return "";
        const vi = document.querySelector('[data-lang="vi"]');
        return JSON.stringify({
          lang: document.documentElement.lang,
          vi: vi ? vi.getAttribute("aria-pressed") : null,
        });
      })()`)) as string;
      // Two identical consecutive readings mean the page has stopped changing;
      // one frame later React's effect has run or it never will.
      if (now && now === previous) settled = JSON.parse(now) as { lang?: string; vi?: string };
      previous = now;
      if (!settled) await sleep(150);
    }
    check("the packaged app offers the language switch", previous !== "");
    check(
      "the packaged app ships in Vietnamese",
      settled?.lang === "vi" && settled?.vi === "true",
      String(previous),
    );

    // Pressing the button is not proof the switch works: a build whose
    // translations failed to bundle would still render the control and leave
    // the page in Vietnamese, and every assertion below would then fail on a
    // label rather than on the thing it was written to test. Read the state,
    // and require the page to have left Vietnamese -- an app that ignores the
    // click while already showing English would otherwise pass both halves.
    await evaluate(`(() => {
      const b = document.querySelector('[data-lang="en"]');
      if (b) b.click();
    })()`);
    const inEnglish = await poll(
      evaluate,
      `(() => {
        const text = document.body.innerText;
        return document.documentElement.lang === "en" &&
               text.includes("Monitor") && text.includes("Docs") &&
               !text.includes("Màn hình");
      })()`,
      40,
    );
    check("pressing EN switches the packaged app to English", inEnglish);

    // The window opens long before the catalogue arrives, so wait for the
    // state the user would see, not for the window.
    let loaded = false;
    for (let i = 0; i < 120 && !loaded; i++) {
      await sleep(250);
      // Either language: the switch above is asynchronous, so an error page
      // could still be in Vietnamese when this runs.
      loaded = await evaluate(
        `!!(document.querySelector("canvas") &&
            !document.body.innerText.includes("Cannot load the dataset") &&
            !document.body.innerText.includes("Không tải được bộ dữ liệu"))`,
      );
      const broken = await evaluate(
        `document.body.innerText.includes("Cannot load the dataset") ||
         document.body.innerText.includes("Không tải được bộ dữ liệu")`,
      );
      if (broken) {
        const msg = await evaluate(`document.body.innerText`);
        throw new Error(`the packaged app could not read its dataset:\n${msg}`);
      }
    }
    check("the packaged app renders the monitor", loaded);

    const label = await evaluate(
      `(() => { const el = document.querySelector("[data-dataset-label]");
                return el ? el.textContent : document.body.innerText.slice(0, 120); })()`,
    );
    check(
      "the navbar names the loaded segment",
      typeof label === "string" && label.includes("Icentia11k"),
      String(label).slice(0, 80),
    );

    // A waveform that never drew leaves a blank canvas; sample it rather than
    // trusting the element's existence. Polled: the canvas is created as soon
    // as the component mounts, a moment before the first frame is painted, and
    // sampling once caught that gap and called a working app broken.
    const painted = await poll(
      evaluate,
      `(() => {
        const c = document.querySelector("canvas");
        if (!c) return { ok: false, why: "no canvas" };
        const ctx = c.getContext("2d");
        if (!ctx) return { ok: false, why: "no 2d context" };
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let lit = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++;
        return { ok: lit > c.width, lit, w: c.width, h: c.height };
      })()`,
    );
    check("the trace is drawn, not an empty canvas", painted?.ok === true, JSON.stringify(painted));

    // The classifier is the part that depends on the model file *and* on the
    // IPC path: it reads data/models/beatcnn.json through the same command.
    const clicked = await evaluate(`(() => {
      const b = document.querySelector('button[aria-label="AI Beat Classifier"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    check("the classifier rail entry exists", clicked === true);

    const panelText = (await poll(
      evaluate,
      `(() => { const el = document.body.innerText;
                return el.includes("AI Beat Classifier") &&
                       (/beats ·/.test(el) || /Classifier failed|no model/i.test(el)) ? el : ""; })()`,
      120,
    )) as string | null;
    check(
      "the packaged app classifies every beat",
      /beats ·/.test(panelText ?? ""),
      (panelText ?? "").includes("no model")
        ? "model missing"
        : String(panelText ?? "").slice(0, 120),
    );
    const m = /([\d,]+) beats · ([\d.]+ (?:ms|s))/.exec(panelText ?? "");
    if (m) console.log(`  note  ${m[1]} beats in ${m[2]}`);

    // The two documentation pages read data/models/*.json and
    // data/catalog/eval_result.json through the same IPC command as the
    // classifier, but a page that fails to load its artefacts still renders its
    // shell — so the check is for a number that can only come from the file.
    for (const [pageLabel, marker] of [
      ["AI Model", storedParamCount()],
      ["Docs", "Rpeak — User Guide"],
    ] as const) {
      const opened = await evaluate(`(() => {
        const b = document.querySelector('button[aria-label=${JSON.stringify(pageLabel)}]');
        if (!b) return false;
        b.click();
        return true;
      })()`);
      const ready = await poll(
        evaluate,
        `!!document.querySelector("[data-page-ready]") &&
         document.body.innerText.includes(${JSON.stringify(marker)})`,
        120,
      );
      check(`the packaged app renders the ${pageLabel} page`, opened === true && !!ready);
    }

    // ---- the dataset folder -------------------------------------------------
    //
    // The native picker cannot be driven from any automation: it is an OS
    // dialog outside the page. So the five checks below drive the same
    // `set_data_root` / `reset_data_root` commands the buttons call, through
    // Tauri's own bridge. What cannot be claimed from here is that the *dialog*
    // opens; `docs/process.md` says so.

    // Back to the monitor: the source control lives in the segment list, which
    // the pages above navigated away from.
    await evaluate(`(() => {
      const b = document.querySelector('button[aria-label="Monitor"]');
      if (b) b.click();
    })()`);
    await poll(evaluate, `!!document.querySelector("canvas")`, 120);

    const invoke = (cmd: string, args: Record<string, unknown>) => `window.__TAURI_INTERNALS__
      .invoke(${JSON.stringify(cmd)}, ${JSON.stringify(args)})`;

    // 1. The app says where it is reading from, and why. `RPEAK_DATA_DIR` is
    // set for this run, so the origin must be `env` — not `besideExe`, which is
    // what an app that ignored the variable would report.
    const shown = await poll(
      evaluate,
      `(() => {
        const b = document.querySelector('button[aria-label="Segments"]');
        if (b) b.click();
        const el = document.querySelector("[data-testid=data-source-path]");
        const origin = document.querySelector("[data-testid=data-source-origin]");
        return el && origin ? JSON.stringify({ path: el.textContent, origin: origin.textContent }) : "";
      })()`,
      40,
    );
    const shownSrc = JSON.parse(shown || "{}") as { path?: string; origin?: string };
    check(
      "the app names the dataset folder and why it chose it",
      !!shownSrc.path && shownSrc.origin === "environment variable",
      String(shown),
    );

    // 2. A folder that is not a dataset is refused, the message names the file
    // that is missing, and the app keeps using the folder it already had —
    // rejecting the new one must not leave the session with no dataset at all.
    const refused = await evaluate(`(async () => {
      try {
        await ${invoke("set_data_root", { path: "C:\\\\Users" })};
        return JSON.stringify({ threw: false });
      } catch (e) {
        const after = await ${invoke("data_source", {})};
        return JSON.stringify({ threw: true, message: String(e), after });
      }
    })()`);
    const rej = JSON.parse(refused || "{}") as {
      threw?: boolean;
      message?: string;
      after?: { path?: string; origin?: string };
    };
    check(
      "a folder without catalog/segments.json is refused and the file is named",
      rej.threw === true &&
        (rej.message ?? "").includes("segments.json") &&
        (rej.after?.path ?? "").length > 0,
      String(refused).slice(0, 200),
    );

    // 3. Switching to the trimmed fixture changes what the app serves, and the
    // reload lands with the fixture's one segment. 24 -> 1 is a number that
    // cannot come from caching: the previous page rendered 24.
    const before = (await evaluate(
      `document.querySelectorAll("[data-panel=segments] [data-testid=segment-row]").length`,
    )) as number;
    const fixture = FIXTURE.replace(/\\/g, "\\\\");
    const switched = await evaluate(`(async () => {
      const s = await ${invoke("set_data_root", { path: fixture })};
      return JSON.stringify(s);
    })()`);
    const sw = JSON.parse(switched || "{}") as { path?: string; origin?: string };
    // The command does not reload the page; the button does. Reload the way it
    // would, then read the catalogue the app now serves.
    await evaluate(`(() => { location.reload(); })()`);
    const after = await poll(
      evaluate,
      `(() => {
        if (document.documentElement.lang !== "en") {
          const b = document.querySelector('[data-lang="en"]');
          if (b) b.click();
        }
        const b = document.querySelector('button[aria-label="Segments"]');
        if (b && !document.querySelector("[data-panel=segments]")) b.click();
        const rows = document.querySelectorAll("[data-panel=segments] [data-testid=segment-row]");
        return rows.length ? rows.length : 0;
      })()`,
      120,
    );
    check(
      "switching the folder changes what the app serves",
      sw.origin === "chosen" && before === fullCount && after === 1,
      `before=${before} after=${after} ${String(switched).slice(0, 120)}`,
    );

    // 4. The choice is remembered across a restart. Delete the file first so
    // this cannot pass on the previous check's leftovers, then relaunch with
    // `RPEAK_DATA_DIR` *removed* — the stored choice is the only reason the
    // fixture could be found.
    rmSync(CONFIG, { force: true });
    await evaluate(`(async () => {
      const s = await ${invoke("set_data_root", { path: fixture })};
      return s.origin;
    })()`);
    const saved = existsSync(CONFIG) ? readFileSync(CONFIG, "utf8") : "";
    app.stop();

    const env2 = { ...baseEnv };
    delete env2.RPEAK_DATA_DIR;
    const restarted = await launch(env2);
    try {
      const persisted = await poll(
        restarted.evaluate,
        `(async () => {
          if (!window.__TAURI_INTERNALS__) return "";
          const s = await ${invoke("data_source", {})};
          return s.origin === "chosen" && s.path.includes("dữ liệu thử")
            ? JSON.stringify(s)
            : "";
        })()`,
        80,
      );
      check(
        "a chosen folder survives a restart, with no environment variable",
        saved.includes("dữ liệu thử") && !!persisted,
        String(persisted).slice(0, 160),
      );
    } finally {
      restarted.stop();
    }

    // 5. Forgetting the choice falls back to the automatic locations, and
    // deletes the file. Again the file is removed first, so the check measures
    // `reset`, not the state the previous one left.
    rmSync(CONFIG, { force: true });
    const third = await launch({ ...baseEnv, RPEAK_DATA_DIR: DATA_DIR });
    try {
      // The bridge is injected with the document, so poll for it before the
      // first `invoke`: a brand-new window can be attached to a frame that has
      // not run any script yet, and the failure then reads as a missing API
      // rather than as the timing it is.
      await poll(third.evaluate, `!!window.__TAURI_INTERNALS__ && !!document.body`, 120);
      const hasFile = await third.evaluate(`(async () => {
        await ${invoke("set_data_root", { path: fixture })};
        return true;
      })()`);
      const reset = await third.evaluate(`(async () => {
        const s = await ${invoke("reset_data_root", {})};
        return JSON.stringify(s);
      })()`);
      const rs = JSON.parse(reset || "{}") as { path?: string; origin?: string };
      check(
        "forgetting the choice falls back to the environment variable",
        hasFile === true && !existsSync(CONFIG) && rs.origin === "env" && rs.path === DATA_DIR,
        String(reset).slice(0, 200),
      );
    } finally {
      third.stop();
    }

    // 6. A remembered folder that the environment variable overrides is
    // *spoken*, and choosing a folder silences the notice. This is the one
    // branch of `sourceNotice` that used to be unreachable: `resolve_from`
    // reported no remembered choice on the env arm, so the sentence existed in
    // the dictionary and could never appear. The file is written before launch,
    // because `resolve_from` runs at startup — `data_source` reports state, it
    // does not re-resolve.
    rmSync(CONFIG, { force: true });
    mkdirSync(dirname(CONFIG), { recursive: true });
    writeFileSync(CONFIG, JSON.stringify({ root: FIXTURE }));
    const overridden = await launch({ ...baseEnv, RPEAK_DATA_DIR: DATA_DIR });
    try {
      await poll(overridden.evaluate, `!!window.__TAURI_INTERNALS__ && !!document.body`, 120);
      // The panel renders only while the segment list is open, and the source
      // control fetches on mount, so the poll returns "" until both have
      // happened. A poll whose expression is a JSON string never retries: the
      // string is truthy on the first sample, panel or no panel.
      const readPanel = `(() => {
        if (document.documentElement.lang !== "en") {
          const b = document.querySelector('[data-lang="en"]');
          if (b) b.click();
        }
        const b = document.querySelector('button[aria-label="Segments"]');
        if (b && !document.querySelector("[data-panel=segments]")) b.click();
        const origin = document.querySelector("[data-testid=data-source-origin]");
        const path = document.querySelector("[data-testid=data-source-path]");
        if (!origin || !path) return "";
        const el = document.querySelector("[data-testid=data-source-notice]");
        return JSON.stringify({
          path: path.textContent,
          origin: origin.textContent,
          notice: el ? el.textContent : null,
        });
      })()`;
      const readOverride = await poll(overridden.evaluate, readPanel, 40);
      const shownOverride = JSON.parse(readOverride || "{}") as {
        path?: string;
        origin?: string;
        notice?: string | null;
      };
      check(
        "an overridden folder is reported, not hidden",
        // Both halves matter: the app must be reading from the environment
        // variable, *and* it must say that a remembered folder lost to it.
        shownOverride.path === DATA_DIR &&
          shownOverride.origin === "environment variable" &&
          (shownOverride.notice ?? "").includes("RPEAK_DATA_DIR is set"),
        readOverride,
      );

      // Choosing a folder makes that sentence false. The button reloads, and
      // the reload is what re-reads `data_source`; calling the command alone
      // updates Rust's state and no React state at all.
      await overridden.evaluate(`(async () => {
        await ${invoke("set_data_root", { path: fixture })};
        location.reload();
        return true;
      })()`);
      const afterChoice = await poll(
        overridden.evaluate,
        `(() => {
          if (!document.body) return "";
          if (document.documentElement.lang !== "en") {
            const b = document.querySelector('[data-lang="en"]');
            if (b) b.click();
          }
          const b = document.querySelector('button[aria-label="Segments"]');
          if (b && !document.querySelector("[data-panel=segments]")) b.click();
          const origin = document.querySelector("[data-testid=data-source-origin]");
          if (!origin || origin.textContent !== "chosen") return "";
          const el = document.querySelector("[data-testid=data-source-notice]");
          return JSON.stringify({ origin: origin.textContent, notice: el ? el.textContent : null });
        })()`,
        60,
      );
      const after = JSON.parse(afterChoice || "{}") as { origin?: string; notice?: string | null };
      check(
        "choosing a folder clears the override notice",
        after.origin === "chosen" && after.notice === null,
        String(afterChoice),
      );
    } finally {
      overridden.stop();
      rmSync(CONFIG, { force: true });
    }

    if (SHOT) {
      // A final launch, because the two above were killed rather than closed.
      const last = await launch(baseEnv);
      try {
        await poll(last.evaluate, `!!document.querySelector("canvas")`, 120);
        const shot = await last.cdp.send("Page.captureScreenshot", { format: "png" });
        writeFileSync(SHOT, Buffer.from(shot.data as string, "base64"));
        console.log(`  note  screenshot ${SHOT}`);
      } finally {
        last.stop();
      }
    }
  } finally {
    // `stop()` is idempotent enough for the success path: killing a dead child
    // throws nothing.
    app.stop();
    // Leave no remembered folder behind for the next run, whatever happened.
    rmSync(CONFIG, { force: true });
  }

  console.log(
    failures === 0 ? "\nsmoke-app: all checks passed" : `\nsmoke-app: ${failures} failed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`smoke-app: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
