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
 * compiled out of release builds, which is exactly what is under test.
 *
 * Usage:
 *   npx tauri build --no-bundle
 *   npx tsx scripts/smoke-app.ts [--exe path/to/rpeak.exe] [--shot out.png]
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const CDP_PORT = 9444;

/**
 * A number that can only come from the model artefact, derived rather than
 * copied: the packaged app reads the same `data/models/beatcnn.json`, so a
 * literal here would go stale on the next retrain and fail for the wrong reason.
 */
function storedParamCount(): string {
  const model = JSON.parse(readFileSync(resolve(here, "../../data/models/beatcnn.json"), "utf8"));
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
// Point it at the repository dataset unless the caller says otherwise.
const DATA_DIR = resolve(here, arg("--data", "../../data"));
// Set by `--no-data-env`, which is how the portable layout is tested: the app
// must find `data/` beside its own executable without being told.
const NO_DATA_ENV = process.argv.includes("--no-data-env");

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

async function main(): Promise<void> {
  if (!existsSync(EXE)) {
    throw new Error(`no packaged app at ${EXE}; run \`npx tauri build --no-bundle\``);
  }
  console.log(`app ${EXE}`);
  console.log(`data ${NO_DATA_ENV ? "(resolved by the app)" : DATA_DIR}`);

  const env: Record<string, string | undefined> = {
    ...process.env,
    // WebView2 forwards these to its Chromium instance.
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}`,
  };
  if (NO_DATA_ENV) delete env.RPEAK_DATA_DIR;
  else env.RPEAK_DATA_DIR = DATA_DIR;

  const app = spawn(EXE, [], { env, stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  app.stderr?.on("data", (d: Buffer) => {
    stderr += d.toString();
  });

  try {
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
      throw new Error(`could not attach to the app window. stderr:\n${stderr}`);
    }

    const cdp = await connect(wsUrl);
    await cdp.send("Runtime.enable");

    const evaluate = async (expr: string): Promise<any> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "evaluate threw");
      return r.result.value;
    };

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
    let cleared = false;
    for (let i = 0; i < 80 && !cleared; i++) {
      cleared = await evaluate(`(() => {
        if (!document.body || !document.documentElement.lang) return false;
        try { localStorage.removeItem("rpeak.lang"); } catch { return false; }
        location.reload();
        return true;
      })()`).catch(() => false);
      if (!cleared) await sleep(250);
    }

    let shipped = "";
    for (let i = 0; i < 80 && !shipped; i++) {
      shipped = await evaluate(`(() => {
        if (!document.querySelector("[data-lang-switch]")) return "";
        const vi = document.querySelector('[data-lang="vi"]');
        return JSON.stringify({
          lang: document.documentElement.lang,
          vi: vi ? vi.getAttribute("aria-pressed") : null,
        });
      })()`);
      if (!shipped) await sleep(250);
    }
    const boot = JSON.parse(shipped || "{}") as { lang?: string; vi?: string };
    check("the packaged app offers the language switch", shipped !== "");
    check(
      "the packaged app ships in Vietnamese",
      boot.lang === "vi" && boot.vi === "true",
      shipped,
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
    let inEnglish = false;
    for (let i = 0; i < 40 && !inEnglish; i++) {
      inEnglish = await evaluate(`(() => {
        const text = document.body.innerText;
        return document.documentElement.lang === "en" &&
               text.includes("Monitor") && text.includes("Docs") &&
               !text.includes("Màn hình");
      })()`);
      if (!inEnglish) await sleep(250);
    }
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
    let painted: { ok?: boolean; lit?: number; w?: number; h?: number; why?: string } = {};
    for (let i = 0; i < 80; i++) {
      painted = await evaluate(`(() => {
        const c = document.querySelector("canvas");
        if (!c) return { ok: false, why: "no canvas" };
        const ctx = c.getContext("2d");
        if (!ctx) return { ok: false, why: "no 2d context" };
        const d = ctx.getImageData(0, 0, c.width, c.height).data;
        let lit = 0;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++;
        return { ok: lit > c.width, lit, w: c.width, h: c.height };
      })()`);
      if (painted.ok) break;
      await sleep(250);
    }
    check("the trace is drawn, not an empty canvas", painted.ok === true, JSON.stringify(painted));

    // The classifier is the part that depends on the model file *and* on the
    // IPC path: it reads data/models/beatcnn.json through the same command.
    const clicked = await evaluate(`(() => {
      const b = document.querySelector('button[aria-label="AI Beat Classifier"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    check("the classifier rail entry exists", clicked === true);

    let panelText = "";
    for (let i = 0; i < 120; i++) {
      await sleep(250);
      panelText = await evaluate(
        `(() => { const el = document.body.innerText;
                  return el.includes("AI Beat Classifier") ? el : ""; })()`,
      );
      if (/beats ·/.test(panelText) || /Classifier failed|no model/i.test(panelText)) break;
    }
    check(
      "the packaged app classifies every beat",
      /beats ·/.test(panelText),
      panelText.includes("no model") ? "model missing" : panelText.slice(0, 120),
    );
    const m = /([\d,]+) beats · ([\d.]+ (?:ms|s))/.exec(panelText);
    if (m) console.log(`  note  ${m[1]} beats in ${m[2]}`);

    // The two documentation pages read data/models/*.json and
    // data/catalog/eval_result.json through the same IPC command as the
    // classifier, but a page that fails to load its artefacts still renders its
    // shell — so the check is for a number that can only come from the file.
    for (const [label, marker] of [
      ["AI Model", storedParamCount()],
      ["Docs", "Rpeak — User Guide"],
    ] as const) {
      const opened = await evaluate(`(() => {
        const b = document.querySelector('button[aria-label=${JSON.stringify(label)}]');
        if (!b) return false;
        b.click();
        return true;
      })()`);
      let ready = false;
      for (let i = 0; i < 120 && !ready; i++) {
        await sleep(250);
        ready = await evaluate(
          `!!document.querySelector("[data-page-ready]") &&
           document.body.innerText.includes(${JSON.stringify(marker)})`,
        );
      }
      check(`the packaged app renders the ${label} page`, opened === true && ready);
    }

    if (SHOT) {
      const shot = await cdp.send("Page.captureScreenshot", { format: "png" });
      writeFileSync(SHOT, Buffer.from(shot.data as string, "base64"));
      console.log(`  note  screenshot ${SHOT}`);
    }

    cdp.close();
  } finally {
    app.kill();
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
