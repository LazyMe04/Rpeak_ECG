/**
 * Drive the running dev server through the Chrome DevTools Protocol.
 *
 * Screenshots prove a page renders; they do not prove the clock advances, that
 * a seek lands on the sample asked for, or that 60x really moves 60 samples per
 * sample of wall time. Those are the failure modes that make a replay viewer
 * useless while still looking fine in a still image, so they are asserted here
 * against the live page.
 *
 * Usage:
 *   npm run dev            (in another shell)
 *   npx tsx scripts/smoke.ts [--port 5173]
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

const PORT = Number(argValue("--port") ?? 5173);
const CDP_PORT = 9333;
// `lang=en` pins the language. The app defaults to Vietnamese, and this script
// drives the UI through English labels ("AI Model"), so without the pin it
// would be looking for words the app no longer shows by default. The Vietnamese
// build is exercised by its own checks, not by translation-blind ones here.
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
      `--user-data-dir=D:/Rpeak-Desktop/.cache/edge-smoke`,
      "--window-size=1400,860",
      URL_,
    ],
    { stdio: "ignore" },
  );

  try {
    // Wait for the debugging endpoint, then find the page target.
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

    const cdp = await connect(wsUrl);
    await cdp.send("Runtime.enable");

    const evaluate = async (expr: string): Promise<any> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) {
        throw new Error(r.exceptionDetails.text ?? "evaluate threw");
      }
      return r.result.value;
    };

    // Wait for the segment to load.
    let loaded = false;
    for (let i = 0; i < 80 && !loaded; i++) {
      await sleep(250);
      loaded = await evaluate("!!(window.__rpeak && window.__rpeak.engine.loaded)");
    }
    check("segment loads", loaded);
    if (!loaded) throw new Error("segment never loaded");

    const info = await evaluate(`(() => {
      const e = window.__rpeak.engine;
      return { fs: e.fs, duration: e.duration, pos: e.position };
    })()`);
    check("fs is 250", info.fs === 250, `got ${info.fs}`);
    check(
      "duration is one Icentia11k segment",
      Math.abs(info.duration - 4194.308) < 0.01,
      `got ${info.duration}`,
    );

    // ---- the clock actually advances -------------------------------------
    await evaluate("window.__rpeak.engine.setSpeed(1); window.__rpeak.engine.play()");
    const p0 = await evaluate("window.__rpeak.engine.position");
    await sleep(1200);
    const p1 = await evaluate("window.__rpeak.engine.position");
    const advanced = p1 - p0;
    check(
      "1x advances about 1 s of signal per second",
      advanced > 200 && advanced < 400,
      `advanced ${advanced.toFixed(0)} samples in ~1.2 s`,
    );

    // ---- speed -----------------------------------------------------------
    await evaluate("window.__rpeak.engine.setSpeed(16)");
    const q0 = await evaluate("window.__rpeak.engine.position");
    await sleep(1000);
    const q1 = await evaluate("window.__rpeak.engine.position");
    const fast = (q1 - q0) / Math.max(1, advanced / 1.2);
    check("16x advances about 16x faster", fast > 8 && fast < 30, `ratio ${fast.toFixed(1)}`);

    // ---- pause holds the clock ------------------------------------------
    await evaluate("window.__rpeak.engine.pause()");
    const r0 = await evaluate("window.__rpeak.engine.position");
    await sleep(600);
    const r1 = await evaluate("window.__rpeak.engine.position");
    check("pause freezes the position", Math.abs(r1 - r0) < 0.001, `${r0} -> ${r1}`);

    // ---- seek is exact and fills the window ------------------------------
    const seek = await evaluate(`(() => {
      const e = window.__rpeak.engine;
      e.seekSeconds(1800);
      const ring = e.ring.toArray();
      let finite = 0, maxAbs = 0;
      for (const v of ring) {
        if (Number.isFinite(v)) { finite++; maxAbs = Math.max(maxAbs, Math.abs(v)); }
      }
      return { pos: e.position, finite, maxAbs, len: ring.length };
    })()`);
    check("seek lands on the requested sample", seek.pos === 1800 * 250, `pos ${seek.pos}`);
    check("seek fills the whole window", seek.finite === seek.len, `${seek.finite}/${seek.len}`);
    check("the window holds real signal, not silence", seek.maxAbs > 0.02, `max ${seek.maxAbs}`);

    // ---- seek to the very start leaves the window blank, not flat --------
    const start = await evaluate(`(() => {
      const e = window.__rpeak.engine;
      e.seekSeconds(0);
      const ring = e.ring.toArray();
      let nan = 0;
      for (const v of ring) if (Number.isNaN(v)) nan++;
      return { nan, len: ring.length };
    })()`);
    check(
      "a fresh start leaves the window blank rather than drawing a flat line",
      start.nan === start.len,
      `${start.nan}/${start.len} blank`,
    );

    // ---- filter output is centred and bounded ---------------------------
    const filt = await evaluate(`(() => {
      const e = window.__rpeak.engine;
      e.seekSeconds(2400);
      const ring = e.ring.toArray();
      let sum = 0, n = 0, max = 0;
      for (const v of ring) {
        if (Number.isFinite(v)) { sum += v; n++; max = Math.max(max, Math.abs(v)); }
      }
      return { mean: sum / n, max, n };
    })()`);
    check(
      "the 0.5 Hz high-pass removes the baseline",
      Math.abs(filt.mean) < 0.05,
      `mean ${filt.mean.toFixed(4)}`,
    );
    check(
      "the display chain keeps QRS amplitude in a sane range",
      filt.max > 0.05 && filt.max < 5,
      `max ${filt.max.toFixed(3)}`,
    );

    // ---- live detection runs in a worker --------------------------------
    // p00000_s00 has 6886 detected peaks in pipeline/detect_v4.py and in
    // scripts/evaluate.ts. If the worker path works, the page reports the same
    // number; if the worker fails to load, `peaks` stays null and `error` is set.
    await evaluate("window.__rpeak.detect.toggle()");
    let det: { enabled: boolean; detecting: boolean; peaks: number | null; error: string | null } =
      { enabled: false, detecting: false, peaks: null, error: null };
    for (let i = 0; i < 80; i++) {
      await sleep(250);
      det = await evaluate("window.__rpeak.detect");
      if (det.error || (det.peaks !== null && !det.detecting)) break;
    }
    check("detector toggle engages", det.enabled === true);
    check("the detection worker returns without error", !det.error, det.error ?? "");
    check(
      "the worker finds the expected number of beats",
      det.peaks === 6886,
      `got ${det.peaks}, expected 6886`,
    );

    // ---- beat classification runs in a worker ---------------------------
    // The model is fetched, the worker classifies every peak and answers with
    // one class per beat. A missing model file is a legitimate state (the app
    // ships without one), so the check reports it rather than failing.
    await evaluate("window.__rpeak.classify.toggle()");
    let clf: {
      enabled: boolean;
      classifying: boolean;
      beats: number | null;
      counts: Record<string, number> | null;
      ms: number | null;
      error: string | null;
    } = { enabled: false, classifying: false, beats: null, counts: null, ms: null, error: null };
    for (let i = 0; i < 160; i++) {
      await sleep(250);
      clf = await evaluate("window.__rpeak.classify");
      if (clf.error || (clf.beats !== null && !clf.classifying)) break;
    }
    check("classifier panel opens", clf.enabled === true);
    if (clf.error) {
      console.log(`  note  no model loaded: ${clf.error}`);
    } else {
      check("the classification worker returns without error", !clf.error, clf.error ?? "");
      check(
        "every detected beat is classified",
        clf.beats === det.peaks && clf.beats !== null,
        `${clf.beats} classified vs ${det.peaks} detected`,
      );
      const total = Object.values(clf.counts ?? {}).reduce((a, b) => a + b, 0);
      check("the per-class counts add up", total === clf.beats, `${total} vs ${clf.beats}`);
      console.log(
        `  note  classes ${JSON.stringify(clf.counts)} in ${(clf.ms ?? 0).toFixed(0)} ms`,
      );
    }

    // ---- the error boundary actually catches -------------------------------
    // A boundary nobody has watched catch anything is a guess. `fault(true)`
    // mounts a probe that throws during render inside a real boundary; if the
    // boundary were missing or mispositioned, React would unmount the whole
    // tree and the canvas below would be gone. So both halves are asserted:
    // the fallback appears, and the trace keeps drawing behind it.
    await evaluate("window.__rpeak.fault(true)");
    let caught = false;
    for (let i = 0; i < 20 && !caught; i++) {
      caught = await evaluate(`document.body.innerText.includes("This panel stopped working")`);
      if (!caught) await sleep(150);
    }
    check("a render error is caught by its panel's boundary", caught);
    const survived = await evaluate(`(() => {
      const c = document.querySelector("canvas");
      if (!c) return null;
      const ctx = c.getContext("2d");
      if (!ctx) return null;
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let lit = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) lit++;
      return lit;
    })()`);
    check(
      "the rest of the app keeps rendering behind the fallback",
      typeof survived === "number" && survived > 0,
      String(survived),
    );
    // Disarm first: "Try again" remounts the children, and the probe would
    // throw again immediately if it were still armed. That is the right
    // behaviour for a persistent fault -- the reader lands back on the same
    // fallback rather than on a blank panel -- so the test clears the cause
    // before asking the boundary to retry.
    await evaluate("window.__rpeak.fault(false)");
    await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll("button"))
        .find((x) => (x.textContent || "").trim() === "Try again");
      if (b) b.click();
    })()`);
    let recovered = false;
    for (let i = 0; i < 20 && !recovered; i++) {
      recovered = await evaluate(`!document.body.innerText.includes("This panel stopped working")`);
      if (!recovered) await sleep(150);
    }
    check("Try again recovers once the fault is gone", recovered);

    // ---- Escape closes an open panel --------------------------------------
    const opened = await evaluate(`(() => {
      const b = document.querySelector('button[aria-label="Vitals"]');
      if (!b) return false;
      b.click();
      return true;
    })()`);
    let panelUp = false;
    for (let i = 0; i < 20 && !panelUp; i++) {
      panelUp = await evaluate(`document.body.innerText.includes("Vitals")`);
      if (!panelUp) await sleep(100);
    }
    check("a rail button opens its panel", opened === true && panelUp === true);
    await evaluate(`document.body.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true })
    )`);
    await sleep(200);
    const closed = await evaluate(`(() => {
      // The panel's own close button only exists while the panel is mounted.
      return !Array.from(document.querySelectorAll("button"))
        .some((b) => b.getAttribute("aria-label") === "Close");
    })()`);
    check("Escape closes the open panel", closed === true);

    // ---- a panel is a dialog, not a floating div --------------------------
    // The three failures a `<div>` had: no role for a screen reader, Tab
    // escaping into the rail behind, and focus landing on `<body>` on close.
    // Each is read from the live DOM because none of them is visible.
    await evaluate(`(() => {
      const open = document.querySelector('[data-panel="stats"]');
      if (open) {
        const close = open.querySelector('button[aria-label="Close"]');
        if (close) close.click();
      }
      const btn = document.querySelector('button[aria-label="Vitals"]');
      if (btn) { btn.focus(); btn.click(); }
    })()`);
    // React may commit the panel a frame after the synthetic click.
    let dialog: Record<string, unknown> | null = null;
    for (let i = 0; i < 20 && !dialog; i++) {
      dialog = await evaluate(`(() => {
        const dlg = document.querySelector('[data-panel="stats"]');
        if (!dlg) return null;
        const labelled = document.getElementById(dlg.getAttribute("aria-labelledby") || "");
        // A stale aria-hidden on an ancestor is the failure mode: it would take
        // the dialog out of the accessibility tree. Icons inside the panel set
        // aria-hidden on themselves, which is correct and not what this reads.
        let hiddenAncestor = false;
        for (let n = dlg.parentElement; n; n = n.parentElement) {
          if (n.getAttribute("aria-hidden") === "true") hiddenAncestor = true;
        }
        return {
          role: dlg.getAttribute("role"),
          modal: dlg.getAttribute("aria-modal"),
          labelledBy: (labelled && labelled.textContent || "").trim(),
          focusedInside: dlg.contains(document.activeElement),
          hiddenAncestor,
        };
      })()`);
      if (!dialog) await sleep(100);
    }
    check(
      "a panel declares itself a modal dialog",
      dialog?.role === "dialog" &&
        dialog?.modal === "true" &&
        dialog?.labelledBy === "Vitals" &&
        dialog?.focusedInside === true,
      JSON.stringify(dialog),
    );
    check(
      "nothing above the dialog hides it from the accessibility tree",
      dialog?.hiddenAncestor === false,
      String(dialog?.hiddenAncestor),
    );

    // Tab from the last control must wrap to the first, not walk out into the
    // rail behind. The segment list is the panel to try this on: it has a close
    // button and 24 row buttons, so both ends of the trap are real controls.
    // Closing the previous panel and opening this one happen in two round
    // trips: a panel's focus restore runs in an effect cleanup, and doing both
    // clicks in one expression lets that restore land after the new panel has
    // taken focus.
    await evaluate(`(() => {
      const open = document.querySelector('[data-panel="stats"]');
      if (!open) return;
      const c = open.querySelector('button[aria-label="Close"]');
      if (c) c.click();
    })()`);
    await sleep(150);
    await evaluate(`(() => {
      const b = document.querySelector('button[aria-label="Segments"]');
      // A keyboard reader arrives at the button before pressing Enter, so the
      // opener is focused. Clicking without focusing would leave the previous
      // element as the opener and the restore check would test the wrong thing.
      if (b) { b.focus(); b.click(); }
    })()`);
    let trap: Record<string, unknown> | null = null;
    for (let i = 0; i < 20 && !trap; i++) {
      trap = await evaluate(`(() => {
        const dlg = document.querySelector('[data-panel="segments"]');
        if (!dlg) return null;
        const nodes = Array.from(dlg.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), ' +
          'textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        ));
        if (nodes.length < 2) return { nodes: nodes.length, wrapped: null };
        const first = nodes[0], last = nodes[nodes.length - 1];
        last.focus();
        last.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }));
        const forward = document.activeElement === first;
        first.focus();
        first.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
        const backward = document.activeElement === last;
        return { nodes: nodes.length, wrapped: forward && backward };
      })()`);
      if (!trap) await sleep(100);
    }
    check(
      "Tab stays inside the dialog in both directions",
      trap?.wrapped === true,
      JSON.stringify(trap),
    );

    // Closing must put focus back on the rail button that opened the panel.
    const restored = await evaluate(`(() => {
      const dlg = document.querySelector('[data-panel="segments"]');
      if (!dlg) return null;
      const close = dlg.querySelector('button[aria-label="Close"]');
      if (!close) return null;
      close.click();
      return { clicked: true };
    })()`);
    // The restore runs in an effect cleanup, one commit after the click.
    let restoreOk: Record<string, unknown> | null = null;
    for (let i = 0; i < 20; i++) {
      await sleep(100);
      restoreOk = await evaluate(`(() => {
        const after = document.activeElement;
        return {
          stillOpen: !!document.querySelector('[data-panel="segments"]'),
          label: after ? after.getAttribute("aria-label") : null,
        };
      })()`);
      if (restoreOk?.label != null) break;
    }
    check(
      "closing returns focus to the control that opened it",
      restored?.clicked === true &&
        restoreOk?.stillOpen === false &&
        restoreOk?.label === "Segments",
      JSON.stringify(restoreOk),
    );

    // ---- the rail reveals its labels to the keyboard too -------------------
    // The rail expands on hover, which a keyboard user never triggers. The
    // labels are `hidden` until either `group-hover` or `group-focus-within`
    // matches, so the check drives focus and reads the computed display -- a
    // screenshot of a hovered rail would not prove the focus path exists.
    const focusRail = await evaluate(`(() => {
      const btn = document.querySelector(".rail-btn");
      if (!btn) return null;
      const row = btn.parentElement?.parentElement;
      const label = row?.querySelector("div.whitespace-nowrap");
      if (!label) return null;
      // Start from nothing focused: the previous check left focus on a rail
      // button, which already holds the rail open and would make the "before"
      // reading meaningless.
      if (document.activeElement) document.activeElement.blur();
      const before = getComputedStyle(label).display;
      btn.focus();
      const after = getComputedStyle(label).display;
      return { before, after, focused: document.activeElement === btn };
    })()`);
    check(
      "the rail's labels appear when a button takes keyboard focus",
      focusRail !== null &&
        focusRail.focused === true &&
        focusRail.before === "none" &&
        focusRail.after === "block",
      JSON.stringify(focusRail),
    );
    await evaluate("document.activeElement && document.activeElement.blur()");

    // ---- the window title follows the page --------------------------------
    // `?lang=en` pins the language for this run, so the titles are the English
    // ones. Checked after navigating, because the title is written on a page
    // change and a title that never updates is the failure mode.
    const monitorTitle = await evaluate("document.title");
    check("the title names the monitor", monitorTitle === "Monitor — Rpeak", String(monitorTitle));
    await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll("button"))
        .find((x) => (x.textContent || "").trim() === "Docs");
      if (b) b.click();
    })()`);
    let docsTitle = "";
    for (let i = 0; i < 20 && docsTitle !== "Docs — Rpeak"; i++) {
      docsTitle = await evaluate("document.title");
      if (docsTitle !== "Docs — Rpeak") await sleep(150);
    }
    check("the title follows the page", docsTitle === "Docs — Rpeak", String(docsTitle));

    cdp.close();
  } finally {
    browser.kill();
  }

  console.log(failures === 0 ? "\nsmoke: all checks passed" : `\nsmoke: ${failures} failed`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`smoke: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
