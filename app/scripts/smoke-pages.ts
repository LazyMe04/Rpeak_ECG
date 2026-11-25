/**
 * Smoke-test the two documentation pages.
 *
 * They look right in a screenshot the moment the shell renders, which is
 * exactly the failure mode worth catching: the pages fetch `data/models/*.json`
 * and `data/catalog/eval_result.json` after mount, and every number on them is
 * derived from those files. A blank "Reading the model artefacts…" panel and a
 * page full of numbers look identical in a thumbnail.
 *
 * It also checks the parts of navigation a screenshot cannot: the monitor stops
 * playing when you leave it, resumes when you come back only if it was playing,
 * and the URL follows the page so a reload lands where the reader was.
 *
 * Usage:
 *   npm run dev            (in another shell)
 *   npx tsx scripts/smoke-pages.ts [--port 5173]
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { MODELS, REPO_ROOT } from "./lib/dataset";

/**
 * The figures the model card must show, read from the same artefacts the page
 * reads. Pinning them as literals here would make this test a second copy of the
 * model card: it would fail on every retrain for the wrong reason, and pass if
 * the page and the test drifted together. Deriving them means the check is
 * "the page shows what the file says", which is the property that matters.
 */
function expectedModelCard() {
  const dir = MODELS;
  const train = JSON.parse(readFileSync(resolve(dir, "beatcnn.train.json"), "utf8"));
  const evalDoc = JSON.parse(readFileSync(resolve(dir, "beatcnn.eval.json"), "utf8"));
  const model = JSON.parse(readFileSync(resolve(dir, "beatcnn.json"), "utf8"));
  const qbound = JSON.parse(readFileSync(resolve(dir, "beatcnn.qboundary.json"), "utf8"));
  const qtrans = JSON.parse(readFileSync(resolve(dir, "beatcnn.qtransfer.json"), "utf8"));
  const peak = qbound.pooled_sweep
    .filter((r: { bias: number }) => r.bias <= 0)
    .reduce((a: { macro_f1: number }, b: { macro_f1: number }) =>
      b.macro_f1 > a.macro_f1 ? b : a,
    );
  const positives = qtrans.rows.filter((r: { delta: number }) => r.delta > 0).length;
  const stored =
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
  return {
    stored: stored.toLocaleString("en-US"),
    trained: train.params.trained.toLocaleString("en-US"),
    accuracy: `${(evalDoc.pooled.accuracy * 100).toFixed(1)}%`,
    best: `Best epoch ${train.best_epoch}`,
    nToQ: evalDoc.pooled.confusion[0][3].toLocaleString("en-US"),
    peakF1: peak.macro_f1.toFixed(3),
    peakNToQ: peak.n_to_q.toLocaleString("en-US"),
    transfer: `${positives} / ${qtrans.rows.length}`,
    firstLoss: train.history[0].loss.toFixed(2),
    epochs: train.history.length,
  };
}

const PORT = Number(argValue("--port") ?? 5173);
const CDP_PORT = 9335;
// `lang=en` pins the language: every assertion below looks for English page
// text ("ECG Beat Classification Model Training"), and the app defaults to
// Vietnamese. The Vietnamese build is checked by `smoke-lang.ts`, which flips
// the switch and reads the same page in the other language.
const URL_ = `http://localhost:${PORT}/?record=p00000_s00&t=60&lang=en`;

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function findBrowser(): string {
  const candidates = [
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  ];
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error("No Chromium-based browser found for the smoke test");
  return hit;
}

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
  const browser = spawn(
    findBrowser(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--mute-audio",
      `--remote-debugging-port=${CDP_PORT}`,
      `--user-data-dir=${join(REPO_ROOT, ".cache/edge-smoke-pages")}`,
      "--window-size=1400,900",
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
          url: string;
          webSocketDebuggerUrl: string;
        }[];
        // An Edge profile can be left with a stale `localhost` tab from an
        // earlier run; attach to this run's tab (created by the URL argument)
        // rather than whichever one the listing happens to list first.
        const mine = list.find((t) => t.type === "page" && t.url.startsWith(URL_));
        const any = list.find((t) => t.type === "page" && t.url.includes("localhost"));
        const page = mine ?? any;
        if (page) {
          // Attaching to the wrong tab is silent: every later eval runs in the
          // wrong document. Say which one.
          if (!mine) console.log(`  --   attached to a pre-existing tab: ${page.url}`);
          wsUrl = page.webSocketDebuggerUrl;
        }
      } catch {
        /* not up yet */
      }
    }
    if (!wsUrl) throw new Error("Could not attach to the browser");

    const cdp = await connect(wsUrl);
    await cdp.send("Runtime.enable");
    // The persistent profile keeps an HTTP cache between runs, so an artefact the
    // pipeline rewrote can be tested as it was yesterday -- the check compares the
    // page against the file on disk, and it must be reading that file.
    await cdp.send("Network.enable");
    await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
    await cdp.send("Page.enable");

    const evaluate = async (expr: string): Promise<any> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) {
        // `text` is only ever "Uncaught"; the description carries the message
        // and stack, which is the difference between a failing check and a
        // page eval that threw.
        const d = r.exceptionDetails;
        throw new Error(
          `${d.text}: ${d.exception?.description ?? d.exception?.value ?? "no description"}`,
        );
      }
      return r.result.value;
    };

    // Navigate rather than reading the tab we happened to attach to. With a
    // persistent profile the listing can offer a target whose document is still
    // `about:blank` while the URL argument is mid-commit, and then every page
    // expression runs in an empty document (`location.pathname` is ""). Driving
    // the navigation ourselves makes the starting document known.
    //
    // `e2e=1` is part of the URL because the app has to know it is under test:
    // otherwise the transport starts paused and the resume checks below measure
    // the wrong thing. The cache is disabled above and stays disabled across
    // this navigation, so the page cannot replay yesterday's artefacts.
    const target = `${URL_}${URL_.includes("?") ? "&" : "?"}e2e=1`;
    await cdp.send("Page.navigate", { url: target });
    for (let i = 0; i < 80; i++) {
      const here = await evaluate("location.href").catch(() => "");
      if (typeof here === "string" && here.startsWith("http")) break;
      await sleep(250);
    }

    /** Click a navbar entry by its visible label. */
    const nav = async (label: string): Promise<boolean> =>
      evaluate(`(() => {
        const b = Array.from(document.querySelectorAll("nav button, button"))
          .find((x) => (x.textContent || "").trim() === ${JSON.stringify(label)});
        if (!b) return false;
        b.click();
        return true;
      })()`);

    /** Wait until a page has read its artefacts and marked itself ready. */
    const waitReady = async (): Promise<boolean> => {
      for (let i = 0; i < 80; i++) {
        if (await evaluate("!!document.querySelector('[data-page-ready]')")) return true;
        await sleep(250);
      }
      return false;
    };

    /**
     * Poll a count until it reaches `want`.
     *
     * Charts measure their container through a ResizeObserver and render
     * nothing until the width is known, so a count taken the instant the
     * artefacts arrive is sometimes 0. Polling is the difference between a real
     * failure and a race -- the same mistake the packaged-app smoke test made
     * with the canvas.
     */
    const waitCount = async (expr: string, want: number): Promise<number> => {
      let got = -1;
      for (let i = 0; i < 20; i++) {
        got = await evaluate(expr);
        if (typeof got === "number" && got >= want) return got;
        await sleep(150);
      }
      return got;
    };

    let loaded = false;
    for (let i = 0; i < 80 && !loaded; i++) {
      await sleep(250);
      loaded = await evaluate("!!(window.__rpeak && window.__rpeak.engine.loaded)");
    }
    check("monitor loads", loaded);
    if (!loaded) throw new Error("the monitor never loaded");

    // ---- AI Model ---------------------------------------------------------
    await evaluate("window.__rpeak.engine.setSpeed(16); window.__rpeak.engine.play()");
    check("the AI Model entry is enabled", (await nav("AI Model")) === true);
    check("the AI Model page finishes reading its artefacts", await waitReady());

    const want = expectedModelCard();
    /**
     * Snapshot the model card, but only once the last section to arrive is up.
     *
     * `[data-page-ready]` is set when the shell has the architecture, the
     * training history, the evaluation and the parity table. The N/Q boundary
     * and the transfer table come from two further files loaded in parallel
     * (`beatcnn.qboundary.json`, `beatcnn.qtransfer.json`) and the page renders
     * those sections only when they land, so a snapshot taken the instant the
     * page says "ready" sometimes misses them. That is a race in this script,
     * not a defect in the page -- the sections are optional by design, because
     * an older artefact set has no sweep to show. One run in six failed on it
     * before this poll, always on "how many checkpoints the rule helps".
     */
    const readModelCard = () =>
      evaluate(`(() => {
      const t = document.body.innerText;
      return {
        title: t.includes("ECG Beat Classification Model Training"),
        params: t.includes(${JSON.stringify(want.stored)}),
        trained: t.includes(${JSON.stringify(want.trained)}),
        accuracy: t.includes(${JSON.stringify(want.accuracy)}),
        best: t.includes(${JSON.stringify(want.best)}),
        confusion: t.includes(${JSON.stringify(want.nToQ)}),
        parity: /8\\/8/.test(t),
        patients: (t.match(/p00(019|114|225|228|239|267)/g) || []).length,
        err: t.includes("Cannot read the model artefacts"),
        boundaryCell: t.includes(${JSON.stringify(want.peakNToQ)}),
        boundaryF1: t.includes(${JSON.stringify(`→ ${want.peakF1}`)}),
        boundaryTransfer: t.includes(${JSON.stringify(want.transfer)}),
        boundaryVerdict: t.includes("not shipped"),
      };
    })()`);
    let model = await readModelCard();
    for (let i = 0; i < 20; i++) {
      if (model.boundaryCell && model.boundaryF1 && model.boundaryTransfer) break;
      await sleep(150);
      model = await readModelCard();
    }
    check("the model page renders its title", model.title === true);
    check("it states the stored parameter count", model.params === true);
    check("it states the trained parameter count too", model.trained === true);
    check("it shows the held-out accuracy", model.accuracy === true);
    check("it names the selected epoch", model.best === true);
    check("the confusion matrix renders its worst cell", model.confusion === true);
    check("the parity table agrees on every window", model.parity === true);
    check("every held-out patient is listed", model.patients >= 6, `${model.patients} rows`);
    check(
      "the N/Q boundary section shows the swept cell",
      model.boundaryCell === true,
      `wanted ${want.peakNToQ}`,
    );
    check("it states the best biased macro-F1", model.boundaryF1 === true, `wanted ${want.peakF1}`);
    check(
      "it reports how many checkpoints the rule helps",
      model.boundaryTransfer === true,
      `wanted ${want.transfer}`,
    );
    check("it says the rule is not shipped", model.boundaryVerdict === true);
    check("no artefact failed to load", model.err === false);

    const polylines = await waitCount(
      "document.querySelectorAll('section svg polyline').length",
      3,
    );
    check("the training charts drew their series", polylines >= 3, `${polylines} polylines`);

    // ---- table of contents ------------------------------------------------
    const toc = await evaluate(`(() => {
      const items = Array.from(document.querySelectorAll('[data-toc-item]'));
      const pane = document.querySelector('[data-page-scroll]');
      const active = () =>
        document.querySelector('[data-toc] a[aria-current="location"]')
          ?.getAttribute('data-toc-item') ?? null;
      return { count: items.length, start: active(), pane: !!pane };
    })()`);
    check("every section has a table-of-contents entry", toc.count >= 10, `${toc.count} entries`);
    check("the contents list starts on the first section", toc.start === "task", String(toc.start));

    // Click a section eight entries down, then read where the pane ended up.
    // The spy measures per frame rather than caching offsets at mount, which is
    // what made the first click report nothing before.
    const jumped = await evaluate(`(async () => {
      const pane = document.querySelector('[data-page-scroll]');
      const item = document.querySelector('[data-toc-item="cost"]');
      if (!item || !pane) return { ok: false };
      item.click();
      await new Promise((r) => setTimeout(r, 1500));
      const el = document.getElementById('cost');
      const off = Math.round(el.getBoundingClientRect().top - pane.getBoundingClientRect().top);
      const active = document.querySelector('[data-toc] a[aria-current="location"]')
        ?.getAttribute('data-toc-item') ?? null;
      return { ok: true, off, active, hash: location.hash, top: Math.round(pane.scrollTop) };
    })()`);
    check(
      "clicking a contents entry scrolls the pane",
      jumped.ok && jumped.top > 0,
      `${jumped.top}px`,
    );
    check("it leaves the heading just below the navbar", jumped.off === 12, `${jumped.off}px`);
    check("the contents entry becomes current", jumped.active === "cost", String(jumped.active));
    check("the URL names the section", jumped.hash === "#cost", String(jumped.hash));

    // ---- charts are keyboard navigable -----------------------------------
    // Focus is what a keyboard user has; dispatch the keys the way the browser
    // would once the SVG holds it.
    const line = await evaluate(`(async () => {
      const svg = document.querySelector('svg[data-chart="line"]');
      if (!svg) return { found: false };
      const key = (k) => {
        svg.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      };
      const read = () => document.querySelector('[data-chart-readout]')?.textContent ?? '';
      const has = () => !!document.querySelector('[data-chart-cursor]');
      const first = { tabIndex: svg.tabIndex, described: !!svg.getAttribute('aria-describedby') };
      key('Home');
      await new Promise((r) => setTimeout(r, 60));
      const atHome = { text: read(), cursor: has() };
      key('End');
      await new Promise((r) => setTimeout(r, 60));
      const atEnd = { text: read(), cursor: has() };
      key('Escape');
      await new Promise((r) => setTimeout(r, 60));
      return { found: true, first, atHome, atEnd, cleared: !has(), afterEsc: read() };
    })()`);
    check("the line chart takes focus", line.found && line.first.tabIndex === 0);
    check("it describes its keys to a screen reader", line.first?.described === true);
    check(
      "Home puts the cursor on the first epoch and reads it out",
      line.atHome?.cursor === true &&
        line.atHome.text.includes(`1 · epoch: Loss ${want.firstLoss}`),
      String(line.atHome?.text),
    );
    check(
      "End puts the cursor on the last epoch",
      line.atEnd?.cursor === true && line.atEnd.text.startsWith(`${want.epochs} · epoch`),
      String(line.atEnd?.text),
    );
    check(
      "the readout says which epoch of how many",
      line.atEnd?.text.endsWith(`(${want.epochs} of ${want.epochs})`),
      String(line.atEnd?.text),
    );
    check(
      "Escape clears the cursor and the readout",
      line.cleared === true && line.afterEsc === "",
      String(line.afterEsc),
    );

    check(
      "the monitor stopped playing behind the page",
      (await evaluate("window.__rpeak.engine.isPlaying")) === false,
    );
    check(
      "the URL carries the page",
      (await evaluate("location.search.includes('page=model')")) === true,
    );

    // ---- Docs -------------------------------------------------------------
    check("the Docs entry is enabled", (await nav("Docs")) === true);
    check("the Docs page finishes reading its artefacts", await waitReady());

    const docs = await evaluate(`(() => {
      const t = document.body.innerText;
      return {
        title: t.includes("Rpeak — User Guide"),
        se: t.includes("97.73%"),
        ppv: t.includes("96.21%"),
        // The detector scores are stored already scaled to percent; a
        // formatter that multiplied by 100 printed 9773.39% here.
        doubled: t.includes("9773"),
        err: t.includes("Cannot read the evaluation artefacts"),
      };
    })()`);
    check("the guide renders its title", docs.title === true);
    check("it reports the detector's sensitivity", docs.se === true);
    check("it reports the detector's PPV", docs.ppv === true);
    check("it does not double-scale the detector percentages", docs.doubled === false);
    const dots = await waitCount(
      "document.querySelectorAll(\"section svg circle[r='4']\").length",
      24,
    );
    check("the per-patient dot plot drew two dots per patient", dots === 24, `${dots} dots`);

    const kbd = await evaluate(`(async () => {
      const svg = document.querySelector('svg[data-chart="dots"]');
      if (!svg) return { found: false };
      const key = (k) => {
        svg.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
      };
      const read = () => document.querySelector('[data-chart-readout]')?.textContent ?? '';
      const tick = () => new Promise((r) => setTimeout(r, 60));
      key('ArrowDown');
      await tick();
      const down = read();
      key('ArrowRight');
      await tick();
      const right = read();
      // PageDown jumps ten rows, which is the only way to reach the bottom of
      // a long per-patient table without pressing Down twenty times.
      key('PageDown');
      await tick();
      const paged = read();
      key('Home');
      await tick();
      const home = read();
      return {
        found: true,
        tabIndex: svg.tabIndex,
        down,
        right,
        paged,
        home,
        described: document.getElementById(svg.getAttribute('aria-describedby') || '')?.textContent || '',
        tipPos: document.querySelector('[data-tip-position]')?.textContent ?? '',
        ring: !!document.querySelector('[data-dot-cursor]'),
      };
    })()`);
    check("the dot plot takes focus", kbd.found && kbd.tabIndex === 0);
    check(
      "the down arrow steps to the next patient",
      kbd.down.startsWith("p00001: Sensitivity"),
      String(kbd.down),
    );
    check(
      "the right arrow steps from Se to PPV on the same patient",
      kbd.right.startsWith("p00001: PPV"),
      String(kbd.right),
    );
    check("the doc plot marks the cursor it is on", kbd.ring === true);
    check(
      "Page Down jumps ten patients, not one",
      kbd.paged.startsWith("p00011: PPV"),
      String(kbd.paged),
    );
    check(
      "Home returns to the first patient from anywhere",
      kbd.home.startsWith("p00000: PPV"),
      String(kbd.home),
    );
    check(
      "the readout says where the cursor is in the list",
      kbd.home.endsWith("(1 of 12)"),
      String(kbd.home),
    );
    check("the tooltip shows the same position", kbd.tipPos === "1 of 12", String(kbd.tipPos));
    check(
      "the key hint mentions the ten-row jump",
      /Page Up and Page Down/.test(kbd.described),
      String(kbd.described).slice(0, 80),
    );
    check("no artefact failed to load", docs.err === false);

    check(
      "the guide links to the model page",
      await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll("button"))
        .find((x) => (x.textContent || "").includes("Open AI Model"));
      if (!b) return false;
      b.click();
      return true;
    })()`),
    );
    check("the link lands on the model page", await waitReady());

    // ---- back to the monitor ---------------------------------------------
    check("the Monitor entry navigates back", (await nav("Monitor")) === true);
    await sleep(400);
    check(
      "the monitor resumed because it was playing when we left",
      (await evaluate("window.__rpeak.engine.isPlaying")) === true,
    );
    check(
      "the URL no longer carries a page",
      (await evaluate("location.search.includes('page=')")) === false,
    );

    // Leaving a paused monitor must not start it.
    await evaluate("window.__rpeak.engine.pause()");
    await nav("Docs");
    await sleep(300);
    await nav("Monitor");
    await sleep(300);
    check(
      "a paused monitor stays paused when you come back",
      (await evaluate("window.__rpeak.engine.isPlaying")) === false,
    );

    // The transport keys must not drive a paused replay behind a page.
    await nav("Docs");
    await sleep(300);
    await evaluate(`window.dispatchEvent(new KeyboardEvent("keydown", { key: " " }))`);
    await sleep(200);
    check(
      "space does not start the replay from a documentation page",
      (await evaluate("window.__rpeak.engine.isPlaying")) === false,
    );

    // ---- a deep link to a segment this catalogue does not have -------------
    // The app used to fall through to the first segment, so a typo'd or stale
    // link showed a *different* recording with nothing on screen saying so --
    // the reader would read the wrong trace believing it was the one linked.
    // It now says so, offers the list, and keeps the app usable.
    await cdp.send("Page.navigate", {
      url: `http://localhost:${PORT}/?record=p99999_s99&t=0&lang=en&e2e=1`,
    });
    let notice = "";
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      notice = await evaluate(`(() => {
        const body = document.body.innerText;
        return body.includes("This link names a segment that is not loaded.")
          ? body
          : "";
      })()`);
      if (notice) break;
    }
    check(
      "a link to a missing segment says so instead of loading another one",
      notice !== "",
      notice ? "" : "no notice appeared",
    );
    check(
      "it names the segment the link asked for",
      notice.includes("p99999_s99"),
      notice.slice(0, 100),
    );
    check(
      "the app is still usable behind the notice",
      (await evaluate(`!!document.querySelector("canvas")`)) === true,
    );
    await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll("button"))
        .find((x) => (x.textContent || "").trim() === "Open the list");
      if (b) b.click();
    })()`);
    let listOpen = false;
    for (let i = 0; i < 40 && !listOpen; i++) {
      listOpen = await evaluate(`(() => {
        const t = document.body.innerText;
        return t.includes("Icentia11k · 24 segments") && !t.includes(
          "This link names a segment that is not loaded.");
      })()`);
      if (!listOpen) await sleep(150);
    }
    check("Open the list clears the notice and shows the segments", listOpen);

    // Back to a real segment for anything that follows.
    await cdp.send("Page.navigate", {
      url: `http://localhost:${PORT}/?record=p00000_s00&t=60&lang=en&e2e=1`,
    });
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      if (
        await evaluate(
          "!!(window.__rpeak && window.__rpeak.engine && window.__rpeak.engine.loaded)",
        )
      ) {
        break;
      }
    }

    cdp.close();
  } finally {
    browser.kill();
  }

  console.log(
    failures === 0 ? "\nsmoke-pages: all checks passed" : `\nsmoke-pages: ${failures} failed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`smoke-pages: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
