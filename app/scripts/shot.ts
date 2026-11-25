/**
 * Capture a screenshot of the running dev server.
 *
 * Usage (dev server in another shell):
 *   npx tsx scripts/shot.ts --out ../docs/shots/g3-detect-dark.png --detect
 *
 * Screenshots are how the UI is reviewed against the reference app, so the
 * capture path is worth having as a script rather than a one-off DevTools
 * session: it is repeatable, it waits for real state (segment loaded, detector
 * finished) instead of sleeping a guessed number of seconds, and it writes the
 * same size every time.
 */
import { spawn } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : fallback;
}
const has = (name: string) => process.argv.includes(name);

const PORT = Number(arg("--port", "5173"));
const CDP_PORT = Number(arg("--cdp", "9334"));
const OUT = arg("--out", "../docs/shots/shot.png")!;
const THEME = arg("--theme", "dark");
const RECORD = arg("--record", "p00000_s00");
const T = arg("--t", "60");
const DETECT = has("--detect");
const PQRST = has("--pqrst");
/** Click buttons by visible text, in order; each label may be repeated. */
const CLICKS = process.argv.reduce<string[]>((acc, a, i) => {
  if (a === "--click" && process.argv[i + 1]) acc.push(process.argv[i + 1]!);
  return acc;
}, []);
/** Evaluate an expression after the page is ready and print the result. */
const EVAL = arg("--eval", "");
/** Accept downloads into this directory, so an export can be checked on disk. */
const DOWNLOAD_DIR = arg("--download-dir", "");
/** Record what the page hands to the browser, then write it from Node. */
const CAPTURE_DOWNLOAD = has("--capture-download");
const SIZE = arg("--size", "1400,860")!;
const PANEL = arg("--panel", "");
/** `model` or `docs` opens a documentation page instead of the monitor. */
const PAGE = arg("--page", "");
/** Scroll the page's content pane by N px before capturing (docs are long). */
const SCROLL = Number(arg("--scroll", "0"));

const URL_ =
  `http://localhost:${PORT}/?record=${RECORD}&t=${T}&theme=${THEME}` +
  (PANEL ? `&panel=${PANEL}` : "") +
  (PAGE ? `&page=${PAGE}` : "");

function findBrowser(): string {
  const candidates = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error("No Chromium-based browser found");
  return hit;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const browser = spawn(
    findBrowser(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--mute-audio",
      "--hide-scrollbars",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=D:/Rpeak-Desktop/.cache/edge-shot`,
      `--window-size=${SIZE}`,
      URL_,
    ],
    { stdio: "ignore" },
  );

  try {
    let wsUrl = "";
    for (let i = 0; i < 60 && !wsUrl; i++) {
      await sleep(250);
      try {
        const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
        const list = (await res.json()) as {
          type: string;
          webSocketDebuggerUrl: string;
          url: string;
        }[];
        const page = list.find((t) => t.type === "page" && t.url.includes("localhost"));
        if (page) wsUrl = page.webSocketDebuggerUrl;
      } catch {
        /* not up yet */
      }
    }
    if (!wsUrl) throw new Error("Could not attach to the browser");

    const ws = new WebSocket(wsUrl);
    await new Promise<void>((res, rej) => {
      ws.addEventListener("open", () => res(), { once: true });
      ws.addEventListener("error", () => rej(new Error("CDP socket failed")), {
        once: true,
      });
    });

    let id = 0;
    const pending = new Map<number, { res: (v: any) => void; rej: (e: Error) => void }>();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(String(ev.data)) as {
        id?: number;
        result?: any;
        error?: { message: string };
      };
      if (msg.id == null) return;
      const p = pending.get(msg.id);
      if (!p) return;
      pending.delete(msg.id);
      if (msg.error) p.rej(new Error(msg.error.message));
      else p.res(msg.result);
    });
    const send = (method: string, params?: unknown) => {
      const myId = ++id;
      return new Promise<any>((res, rej) => {
        pending.set(myId, { res, rej });
        ws.send(JSON.stringify({ id: myId, method, params }));
      });
    };
    const evaluate = async (expr: string) => {
      const r = await send("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.text ?? "evaluate threw");
      return r.result.value;
    };

    await send("Runtime.enable");
    await send("Page.enable");
    // The profile under .cache/edge-shot outlives a run, so a JSON the pipeline
    // just rewrote can come back from the HTTP cache and a screenshot then shows
    // numbers that are no longer on disk. Reload once with the cache off.
    //
    // Navigate explicitly first: the listing can hand back a target whose
    // document is still `about:blank` while the launch URL is mid-commit, and a
    // reload of that leaves the capture on an empty page.
    try {
      await send("Network.enable");
      await send("Network.setCacheDisabled", { cacheDisabled: true });
    } catch {
      /* older targets may not expose Network; the screenshot is still useful */
    }
    await send("Page.navigate", { url: URL_ });

    // Downloads: a headless page discards them unless behaviour is overridden
    // and a directory is granted, so an export test would silently prove
    // nothing. Granting the path is also what makes the file land on disk.
    //
    // Edge cancels every download in this automation profile whatever the
    // command configuration (headless or not, any target directory,
    // SmartScreen off), so the CDP grant is best-effort: with --capture-download
    // the page hook below records the blob the app handed to the anchor and
    // Node writes those exact bytes instead.
    if (DOWNLOAD_DIR) {
      try {
        await send("Browser.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: DOWNLOAD_DIR,
          eventsEnabled: true,
        });
      } catch (e) {
        console.log(`Browser.setDownloadBehavior failed (${(e as Error).message}); trying Page`);
        await send("Page.setDownloadBehavior", {
          behavior: "allow",
          downloadPath: DOWNLOAD_DIR,
        });
      }
    }
    if (CAPTURE_DOWNLOAD) {
      // Read the blob inside the click, not afterwards: the app revokes the
      // object URL a second later, and a later fetch of it fails.
      await evaluate(`(() => {
        window.__downloads = [];
        const click = HTMLAnchorElement.prototype.click;
        HTMLAnchorElement.prototype.click = function () {
          if (this.download) {
            window.__downloads.push(fetch(this.href).then((r) => r.text()).then((text) => ({
              name: this.download,
              text,
            })));
          }
          return click.call(this);
        };
        return true;
      })()`);
    }

    let loaded = false;
    for (let i = 0; i < 80 && !loaded; i++) {
      await sleep(250);
      // The documentation pages load their numbers asynchronously and mark the
      // root once the artefacts are in. Waiting on the engine would hang here.
      loaded = PAGE
        ? await evaluate("!!document.querySelector('[data-page-ready]')")
        : await evaluate("!!(window.__rpeak && window.__rpeak.engine.loaded)");
    }
    if (!loaded) throw new Error(PAGE ? "the page never finished loading" : "segment never loaded");

    if (DETECT) {
      await evaluate("window.__rpeak.detect.toggle()");
      let state = { peaks: null as number | null, detecting: true, error: null as string | null };
      for (let i = 0; i < 80; i++) {
        await sleep(250);
        state = await evaluate("window.__rpeak.detect");
        if (state.error || (state.peaks !== null && !state.detecting)) break;
      }
      if (state.error) throw new Error(`detector: ${state.error}`);
      if (state.peaks === null) throw new Error("detector never finished");
      console.log(`detected ${state.peaks} peaks`);
    }

    if (PQRST) {
      await evaluate("window.__rpeak.delineate.toggle()");
      let state = {
        beats: null as number | null,
        delineating: true,
        error: null as string | null,
        median: null as unknown,
      };
      for (let i = 0; i < 80; i++) {
        await sleep(250);
        state = await evaluate("window.__rpeak.delineate");
        if (state.error || (state.beats !== null && !state.delineating)) break;
      }
      if (state.error) throw new Error(`delineate: ${state.error}`);
      if (state.beats === null) throw new Error("delineation never finished");
      console.log(`delineated ${state.beats} beats`, state.median);
    }

    // Pause and repaint so the frame is a deterministic one, not a moment
    // mid-scroll where the trace position depends on machine load.
    await evaluate("window.__rpeak && window.__rpeak.engine.pause()");
    await sleep(600);

    if (SCROLL) {
      await evaluate(`(() => {
        const el = document.querySelector("[data-page-scroll]");
        if (el) el.scrollTop = ${SCROLL};
        return el ? el.scrollTop : null;
      })()`);
      await sleep(400);
    }

    for (const label of CLICKS) {
      // Drive a real button by label. Used to exercise the session recorder
      // end to end: the panel only builds a report after an actual click.
      const clicked = await evaluate(`(() => {
        const label = ${JSON.stringify(label)};
        const btns = Array.from(document.querySelectorAll("button"));
        const b = btns.find((x) => (x.textContent || "").trim().startsWith(label));
        if (!b) return false;
        b.click();
        return true;
      })()`);
      if (!clicked) throw new Error(`no button starting with "${label}"`);
      await sleep(1500);
    }

    if (EVAL) {
      console.log(JSON.stringify(await evaluate(EVAL), null, 1));
    }

    if (CAPTURE_DOWNLOAD) {
      // The click hook already started reading each blob; wait for those reads.
      const got = await evaluate(`Promise.all(window.__downloads || [])`);
      for (const f of got as { name: string; text: string }[]) {
        const path = `${(DOWNLOAD_DIR ?? "").replace(/\/$/, "")}/${f.name}`;
        writeFileSync(path, f.text);
        console.log(`captured ${f.name} (${f.text.length} bytes) -> ${path}`);
      }
    }

    const shot = await send("Page.captureScreenshot", { format: "png" });
    writeFileSync(OUT, Buffer.from(shot.data, "base64"));
    console.log(`wrote ${OUT}`);
    ws.close();
  } finally {
    browser.kill();
  }
}

main().catch((e) => {
  console.error(`shot: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
