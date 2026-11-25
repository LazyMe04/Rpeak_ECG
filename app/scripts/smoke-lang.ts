/**
 * Smoke-test the Vietnamese build.
 *
 * The other three smoke scripts pin `?lang=en` and read English labels, which
 * means none of them would notice if the Vietnamese dictionary stopped being
 * wired up at all: `t()` falls back to English, so a page with no translations
 * still renders, still passes every assertion, and still looks finished.
 *
 * This script is the one that fails in that world. It asserts the shipped
 * default is Vietnamese, that the switch in the navbar changes the page (and
 * the `<html lang>` and `aria-pressed` with it), that the choice survives a
 * reload, that `?lang=en` still wins over a stored preference, and that numbers
 * are printed in the language's own convention -- the mistake a translated
 * page makes most easily is Vietnamese prose around English decimal points.
 *
 * Usage:
 *   npm run dev            (in another shell)
 *   npx tsx scripts/smoke-lang.ts [--port 5173]
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** The accuracy the model card must show, derived from the artefact it reads. */
function heldOutAccuracy() {
  const evalDoc = JSON.parse(
    readFileSync(resolve(here, "../../data/models/beatcnn.eval.json"), "utf8"),
  );
  const v = evalDoc.pooled.accuracy * 100;
  const one = { minimumFractionDigits: 1, maximumFractionDigits: 1 };
  return {
    vi: `${v.toLocaleString("vi-VN", one)}%`,
    en: `${v.toLocaleString("en-US", one)}%`,
    // What a page that translated its prose but not its numbers would print.
    bothThisWay: v.toFixed(1),
  };
}

const PORT = Number(argValue("--port") ?? 5173);
const CDP_PORT = 9336;
// No `lang` parameter: this run is about what the app does when nobody says.
const URL_ = `http://localhost:${PORT}/?record=p00000_s00&t=60`;

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
      // A profile of its own, not shared with smoke-pages: this run stores a
      // language preference, and the other run must not inherit it.
      `--user-data-dir=D:/Rpeak-Desktop/.cache/edge-smoke-lang`,
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
        const d = r.exceptionDetails;
        throw new Error(
          `${d.text}: ${d.exception?.description ?? d.exception?.value ?? "no description"}`,
        );
      }
      return r.result.value;
    };

    /**
     * Navigate and wait for *this* document's app to load.
     *
     * `Page.navigate` resolves as soon as the navigation is committed, not when
     * the page is ready, so a poll that only asks `engine.loaded` can be
     * answered by the document that was already on screen -- which made the
     * reload check below pass without a reload ever having happened. The token
     * lives on the window, so it disappears with the old context.
     */
    const open = async (url: string): Promise<boolean> => {
      await evaluate("window.__navToken = true").catch(() => {});
      await cdp.send("Page.navigate", { url });
      for (let i = 0; i < 80; i++) {
        const ok = await evaluate(
          "!!(window.__rpeak && window.__rpeak.engine && window.__rpeak.engine.loaded" +
            " && window.__navToken !== true)",
        ).catch(() => false);
        if (ok) return true;
        await sleep(250);
      }
      return false;
    };

    // The profile is persistent, so a previous run could have left "en"
    // behind. Get onto the app's own origin first: `localStorage` belongs to
    // an origin, and at attach time the window may still be the browser's
    // start page, where the removal would silently apply to the wrong storage.
    check("the monitor loads", await open(URL_));
    await evaluate("localStorage.removeItem('rpeak.lang')");
    check("a fresh visit starts from the shipped default", await open(URL_));

    // ---- the default ------------------------------------------------------
    const first = await evaluate(`(() => {
      const text = document.body.innerText;
      const en = document.querySelector('[data-lang="en"]');
      const vi = document.querySelector('[data-lang="vi"]');
      return {
        htmlLang: document.documentElement.lang,
        en: en ? en.getAttribute("aria-pressed") : null,
        vi: vi ? vi.getAttribute("aria-pressed") : null,
        switchPresent: !!document.querySelector("[data-lang-switch]"),
        vietnameseNav: text.includes("Màn hình") && text.includes("Hướng dẫn"),
        englishNav: text.includes("Monitor") && text.includes("Docs"),
      };
    })()`);
    check("a first visit opens in Vietnamese", first.htmlLang === "vi", String(first.htmlLang));
    check("the navbar is translated", first.vietnameseNav === true && first.englishNav === false);
    check("the language switch renders", first.switchPresent === true);
    check(
      "it marks Vietnamese as the current language",
      first.vi === "true" && first.en === "false",
      `vi=${first.vi} en=${first.en}`,
    );

    // ---- the switch -------------------------------------------------------
    await evaluate(`document.querySelector('[data-lang="en"]').click()`);
    await sleep(300);
    const toEn = await evaluate(`(() => {
      const text = document.body.innerText;
      return {
        htmlLang: document.documentElement.lang,
        en: document.querySelector('[data-lang="en"]').getAttribute("aria-pressed"),
        vi: document.querySelector('[data-lang="vi"]').getAttribute("aria-pressed"),
        englishNav: text.includes("Monitor") && text.includes("Docs"),
      };
    })()`);
    check("clicking EN switches the page", toEn.englishNav === true);
    check("it moves the pressed state with it", toEn.en === "true" && toEn.vi === "false");
    check("it retags the document", toEn.htmlLang === "en", String(toEn.htmlLang));

    // ---- persistence ------------------------------------------------------
    // The token `open` uses also proves the reload happened; a check that only
    // reads the language would be satisfied by the document it just left.
    check("a switch to English survives a reload", await open(URL_));
    const afterReload = await evaluate(
      `({ lang: document.documentElement.lang,
          monitor: document.body.innerText.includes("Monitor"),
          token: window.__navToken === true })`,
    );
    check(
      "the stored preference is used on the next visit",
      afterReload.lang === "en" && afterReload.monitor === true && afterReload.token === false,
      JSON.stringify(afterReload),
    );

    // ---- the URL still wins ----------------------------------------------
    check(
      "?lang=vi overrides a stored English preference",
      (await open(`${URL_}&lang=vi`)) === true &&
        (await evaluate(`document.documentElement.lang`)) === "vi",
    );

    // ---- numbers follow the language -------------------------------------
    const acc = heldOutAccuracy();
    const openModel = () =>
      evaluate(`(() => {
        const b = Array.from(document.querySelectorAll("button"))
          .find((x) => /^(Mô hình AI|AI Model)$/.test((x.textContent || "").trim()));
        if (!b) return false;
        b.click();
        return true;
      })()`);

    check("the AI Model entry is reachable in Vietnamese", (await openModel()) === true);
    let ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      ready = await evaluate("!!document.querySelector('[data-page-ready]')");
      if (!ready) await sleep(250);
    }
    check("the model card reads its artefacts in Vietnamese", ready);

    const viText = await evaluate("document.body.innerText");
    check(
      "the model card is translated",
      viText.includes("Huấn luyện mô hình phân loại nhịp ECG"),
      viText.slice(0, 100),
    );
    check(
      `it prints the accuracy in Vietnamese (${acc.vi})`,
      viText.includes(acc.vi),
      `wanted ${acc.vi}`,
    );
    check(
      "it does not print a dot decimal in Vietnamese prose",
      viText.includes(`${acc.bothThisWay}%`) === false,
      `found ${acc.bothThisWay}%`,
    );

    // The table of contents and the section headings were the last things on
    // this page to stay English: both are passed as plain attributes to
    // components that translate them internally, so no `t(...)` call in the
    // page ever names them and the static audit cannot see them. A rendered
    // check is the only one that catches a heading that was never keyed.
    const headings = await evaluate(`(() => {
      const toc = Array.from(document.querySelectorAll("[data-toc-item]"))
        .map((a) => (a.textContent || "").trim());
      const titles = Array.from(document.querySelectorAll("section h2"))
        .map((h) => (h.textContent || "").trim());
      return { toc, titles };
    })()`);
    const english = [
      "Architecture",
      "Training",
      "Held-out evaluation",
      "Per patient",
      "Parity",
      "Inference cost",
      "What it cannot see",
    ];
    const read = [...(headings.toc as string[]), ...(headings.titles as string[])].map((s) =>
      s.replace(/^\d+\s*/, ""),
    );
    // Without this the check below passes on an empty list — a page whose
    // sections failed to render looks exactly like a page with no leftovers.
    check(
      "the model card has a contents list and section headings to read",
      (headings.toc as string[]).length >= 10 && (headings.titles as string[]).length >= 10,
      `${(headings.toc as string[]).length} entries, ${(headings.titles as string[]).length} headings`,
    );
    const leftovers = read.filter((s) => english.includes(s));
    check(
      "every section heading and contents entry is in Vietnamese",
      leftovers.length === 0,
      leftovers.join(", "),
    );
    check(
      "the architecture table's row labels are in Vietnamese",
      viText.includes("Tích chập 1") && viText.includes("Gộp trung bình toàn cục theo thời gian"),
      viText.includes("Conv 1") ? "still says Conv 1" : "",
    );

    await evaluate(`document.querySelector('[data-lang="en"]').click()`);
    await sleep(300);
    const enText = await evaluate("document.body.innerText");
    check(`the same figure in English is ${acc.en}`, enText.includes(acc.en), `wanted ${acc.en}`);

    // ---- Docs in Vietnamese ----------------------------------------------
    await evaluate(`document.querySelector('[data-lang="vi"]').click()`);
    await sleep(300);
    const toDocs = await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll("button"))
        .find((x) => /^(Hướng dẫn|Docs)$/.test((x.textContent || "").trim()));
      if (!b) return false;
      b.click();
      return true;
    })()`);
    ready = false;
    for (let i = 0; i < 80 && !ready; i++) {
      ready = await evaluate("!!document.querySelector('[data-page-ready]')");
      if (!ready) await sleep(250);
    }
    const docsText = await evaluate("document.body.innerText");
    check("the Docs entry is reachable in Vietnamese", toDocs === true && ready === true);
    check(
      "the guide's title is translated",
      docsText.includes("Rpeak — Hướng dẫn sử dụng"),
      docsText.slice(0, 100),
    );

    // ---- the signal-quality label is translated ---------------------------
    // The catalogue stores "saturated" / "low-amplitude" as ASCII machine
    // values, and the vitals panel used to render them straight into the page,
    // so a Vietnamese reader saw English. It reached the screen through a
    // *variable*, which is exactly what the static audit cannot check: the
    // dictionary entry is present and apparently used, but nothing guarantees
    // the render site translates it. So render it and read it.
    await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll("button"))
        .find((x) => /^(Màn hình|Monitor)$/.test((x.textContent || "").trim()));
      if (b) b.click();
    })()`);
    // `URL_` already carries a `record`; appending another one would leave
    // `URLSearchParams.get()` reading the first, so the page would stay on
    // p00000_s00 and the check below would pass on the wrong label.
    const saturated = `http://localhost:${PORT}/?record=p00003_s00&t=60&lang=vi`;
    check("a saturated segment loads", await open(saturated));

    const openVitals = () =>
      evaluate(`(() => {
        const want = /^(Chỉ số sống|Vitals|Ẩn chỉ số sống|Hide Vitals)$/;
        const hit = Array.from(document.querySelectorAll("button"))
          .find((x) => want.test((x.getAttribute("aria-label") || "").trim()));
        if (!hit) return false;
        hit.click();
        return true;
      })()`);
    check("the vitals panel can be opened", (await openVitals()) === true);
    let vitalsText = "";
    for (let i = 0; i < 40; i++) {
      vitalsText = await evaluate("document.body.innerText");
      if (vitalsText.includes("Chất lượng")) break;
      await sleep(150);
    }
    check(
      "a saturated segment is labelled in Vietnamese",
      vitalsText.includes("Bão hoà"),
      vitalsText.slice(vitalsText.indexOf("Chất lượng"), vitalsText.indexOf("Chất lượng") + 60),
    );
    check(
      "its machine value is not shown to the reader",
      vitalsText.includes("saturated") === false,
    );

    // The picker shows the same label, only when it is not fine -- a row of
    // green "normal" ticks would be noise.
    const picker = await evaluate(`(() => {
      const b = Array.from(document.querySelectorAll("button"))
        .find((x) => /^(Danh sách đoạn|Segments|Ẩn danh sách đoạn|Hide Segments)$/.test(
          (x.getAttribute("aria-label") || "").trim()));
      if (!b) return null;
      b.click();
      return true;
    })()`);
    let pickerText = "";
    for (let i = 0; i < 40; i++) {
      pickerText = await evaluate("document.body.innerText");
      if (pickerText.includes("p00003_s00")) break;
      await sleep(150);
    }
    check("the segment list opens", picker === true);
    check(
      "the list warns about a saturated segment in Vietnamese",
      pickerText.includes("Bão hoà") && pickerText.includes("Biên độ thấp"),
      pickerText.includes("saturated") ? "still shows the machine value" : "",
    );

    // ---- the window title is in the page's language -----------------------
    // The taskbar is the one place the language switch cannot reach after the
    // fact: a Vietnamese app with an English window title looks like a bug in
    // the shell. This run is on the monitor page, opened with `?lang=vi`.
    let viTitle = "";
    for (let i = 0; i < 20 && viTitle !== "Màn hình — Rpeak"; i++) {
      viTitle = await evaluate("document.title");
      if (viTitle !== "Màn hình — Rpeak") await sleep(150);
    }
    await evaluate(`document.querySelector('[data-lang="en"]').click()`);
    let enTitle = "";
    for (let i = 0; i < 20 && enTitle !== "Monitor — Rpeak"; i++) {
      enTitle = await evaluate("document.title");
      if (enTitle !== "Monitor — Rpeak") await sleep(150);
    }
    check(
      "the window title follows the page and the language",
      viTitle === "Màn hình — Rpeak" && enTitle === "Monitor — Rpeak",
      `vi=${viTitle} en=${enTitle}`,
    );

    cdp.close();
  } finally {
    browser.kill();
  }

  console.log(
    failures === 0 ? "\nsmoke-lang: all checks passed" : `\nsmoke-lang: ${failures} failed`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(`smoke-lang: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
