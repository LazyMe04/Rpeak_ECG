/**
 * The light theme, asserted instead of photographed.
 *
 * G2 shipped the light theme with seven screenshots and no check. Every test in
 * the project reads structure, numbers or behaviour; none reads colour. A
 * change that left light-theme text at 2:1 against its own panel would pass the
 * whole gate and be found by whoever next switched the theme.
 *
 * This reads the *resolved* design tokens out of the live document in both
 * themes and computes real contrast ratios -- text on the panel fill composited
 * over the page, chart axes on the chart surface, the trace on the grid -- so
 * "readable in light mode" becomes a number that can regress.
 *
 * Usage:
 *   npm run dev            (in another shell)
 *   npx tsx scripts/smoke-theme.ts [--port 5173]
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { contrast, over, parseColor, type Rgb } from "./lib/contrast";
import { REPO_ROOT } from "./lib/dataset";

const PORT = Number(argValue("--port") ?? 5173);
const CDP_PORT = 9337;
// `lang=en` keeps the labels this script does not read out of the way; the
// theme is what is under test.
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

/** Tokens the readability claims depend on, read from the live document. */
const TOKENS = [
  "--background",
  "--panel-fill",
  "--panel-border",
  "--text",
  "--text-dim",
  "--text-faint",
  "--grid-minor",
  "--chart-grid",
  "--chart-axis",
  "--wave",
  "--graph-bg",
  "--accent",
  "--danger",
  "--success",
] as const;

async function main(): Promise<void> {
  const browser = spawn(
    findBrowser(),
    [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--mute-audio",
      `--remote-debugging-port=${CDP_PORT}`,
      // Its own profile: the theme is persisted, and a run must not inherit the
      // previous run's choice.
      `--user-data-dir=${join(REPO_ROOT, ".cache/edge-smoke-theme")}`,
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
        const page = list.find((t) => t.type === "page" && t.url.includes("localhost"));
        if (page) wsUrl = page.webSocketDebuggerUrl;
      } catch {
        /* not up yet */
      }
    }
    if (!wsUrl) throw new Error("Could not attach to the browser");

    const cdp = await connect(wsUrl);
    await cdp.send("Runtime.enable");
    await cdp.send("Page.enable");
    await cdp.send("Page.navigate", { url: URL_ });

    const evaluate = async (expr: string): Promise<any> => {
      const r = await cdp.send("Runtime.evaluate", {
        expression: expr,
        returnByValue: true,
        awaitPromise: true,
      });
      if (r.exceptionDetails) {
        const d = r.exceptionDetails;
        throw new Error(
          `${d.text}: ${d.exception?.description ?? d.exception?.value ?? "no description"}`,
        );
      }
      return r.result.value;
    };

    let loaded = false;
    for (let i = 0; i < 80 && !loaded; i++) {
      loaded = await evaluate("!!(window.__rpeak && window.__rpeak.engine.loaded)");
      if (!loaded) await sleep(250);
    }
    check("the monitor loads", loaded);
    if (!loaded) throw new Error("the monitor never loaded");

    /** Resolve the tokens for a theme, by setting it and reading the computed values. */
    const readTheme = async (theme: "dark" | "light"): Promise<Record<string, string>> => {
      await evaluate(`document.documentElement.dataset.theme = ${JSON.stringify(theme)}`);
      await sleep(120);
      return evaluate(`(() => {
        const cs = getComputedStyle(document.documentElement);
        const out = {};
        for (const name of ${JSON.stringify(TOKENS)}) out[name] = cs.getPropertyValue(name).trim();
        return out;
      })()`);
    };

    const dark = await readTheme("dark");
    const light = await readTheme("light");

    // The theme actually reached the document, or every ratio below is dark.
    const applied = await evaluate(`(() => ({
      theme: document.documentElement.dataset.theme,
      background: getComputedStyle(document.documentElement).getPropertyValue("--background").trim(),
    }))()`);
    check(
      "switching the theme replaces the palette",
      applied.theme === "light" && applied.background === light["--background"],
      JSON.stringify(applied),
    );
    check(
      "the two palettes are actually different",
      dark["--text"] !== light["--text"] && dark["--panel-fill"] !== light["--panel-fill"],
      `text ${dark["--text"]} / ${light["--text"]}`,
    );

    interface Sample {
      label: string;
      fg: string;
      bg: string;
      /** The panel fill is translucent; it composites over --graph-bg. */
      panel?: boolean;
      min: number;
    }

    const samples = (t: Record<string, string>): Sample[] => [
      {
        label: "body text on the panel",
        fg: t["--text"]!,
        bg: t["--panel-fill"]!,
        panel: true,
        min: 4.5,
      },
      {
        label: "dim text on the panel",
        fg: t["--text-dim"]!,
        bg: t["--panel-fill"]!,
        panel: true,
        min: 4.5,
      },
      {
        label: "faint text on the panel",
        fg: t["--text-faint"]!,
        bg: t["--panel-fill"]!,
        panel: true,
        min: 3.0,
      },
      // Chart tick labels are drawn in --text-faint on the chart surface, not
      // on a panel, so that is the background to measure against.
      { label: "chart tick labels", fg: t["--text-faint"]!, bg: t["--graph-bg"]!, min: 3.0 },
      { label: "the trace on the grid", fg: t["--wave"]!, bg: t["--graph-bg"]!, min: 3.0 },
      // A 1px cursor line is a non-text graphic: WCAG 1.4.11 asks 3:1.
      { label: "the chart cursor line", fg: t["--chart-axis"]!, bg: t["--graph-bg"]!, min: 3.0 },
      {
        label: "the accent on the panel",
        fg: t["--accent"]!,
        bg: t["--panel-fill"]!,
        panel: true,
        min: 3.0,
      },
      {
        label: "the danger tone on the panel",
        fg: t["--danger"]!,
        bg: t["--panel-fill"]!,
        panel: true,
        min: 3.0,
      },
    ];

    for (const theme of ["light", "dark"] as const) {
      const t = theme === "light" ? light : dark;
      for (const s of samples(t)) {
        let bg: Rgb = parseColor(s.bg);
        if (s.panel) {
          // The panel floats over the graph surface, so that is what shows
          // through its translucency.
          bg = over(bg, parseColor(t["--graph-bg"]!));
        }
        const ratio = contrast(over(parseColor(s.fg), bg), bg);
        check(
          `${theme}: ${s.label} is at least ${s.min}:1`,
          ratio >= s.min,
          `${ratio.toFixed(2)}:1`,
        );
      }
    }

    // A painted canvas in the light theme, not a blank one: the theme switch
    // rebuilds the palette and the canvas has to repaint with it.
    const lit = await evaluate(`(() => {
      document.documentElement.dataset.theme = "light";
      const c = document.querySelector("canvas");
      if (!c) return null;
      const ctx = c.getContext("2d");
      const d = ctx.getImageData(0, 0, c.width, c.height).data;
      let on = 0;
      for (let i = 3; i < d.length; i += 4) if (d[i] > 0) on++;
      return on;
    })()`);
    check(
      "the light theme still paints the trace",
      typeof lit === "number" && lit > 0,
      String(lit),
    );

    cdp.close();
  } finally {
    browser.kill();
  }

  console.log(
    failures === 0 ? "\nsmoke-theme: all checks passed" : `\nsmoke-theme: ${failures} failed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`smoke-theme: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
