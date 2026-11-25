/**
 * Two languages, one dictionary.
 *
 * The default is Vietnamese. English is not translated back through a
 * dictionary: `t()` takes the English sentence as its key and returns it
 * unchanged when the locale is `en`, so the English build costs nothing and a
 * missing Vietnamese entry falls back to readable English rather than to a
 * key like `panel.hrv.title`.
 *
 * That choice has one failure mode -- a string that never calls `t()` is
 * invisible to the dictionary and simply stays English -- and it cannot be
 * closed by reading the source, because some components translate their props
 * internally: `Section` renders `t(title)`, so a heading passed as
 * `title="Training"` is keyed without any `t(` call naming it. Two checks
 * share the work. `pipeline/check_i18n.py` asserts coverage mechanically --
 * every `t("...")` literal has an entry, every entry is asked for, every
 * `{placeholder}` matches. `app/scripts/smoke-lang.ts` renders the pages in
 * both languages and fails on an English heading or contents entry left in the
 * Vietnamese one, which is the only check that can see a prop-translated
 * string. Run them with `python -I pipeline/check_i18n.py` and
 * `npm run smoke:lang`.
 *
 * Interpolation is `{name}`. Vietnamese has no plural forms, so counts read
 * the same at 1 and at 12 and no plural machinery is needed.
 *
 * Numbers are *not* left to React. Vietnamese writes 72,7% where English writes
 * 72.7%, so every displayed number goes through `num()`, which formats with
 * `vi-VN`. The one exception is the CSV export: it is comma-separated, so a
 * comma decimal would split a value into two fields.
 *
 * Persistence is per-device (`localStorage`), for the same reason as the
 * theme: it is a display preference, not data. Every access is guarded, since
 * it throws in private windows.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { VI } from "./i18n.vi";
import { VI_MODEL } from "./i18n.vi.model";

/** One lookup for every screen: the app's chrome plus the model card. */
const DICT: Record<string, string> = { ...VI, ...VI_MODEL };

export type Lang = "en" | "vi";

const STORAGE_KEY = "rpeak.lang";

export const LANGS: { id: Lang; label: string; name: string }[] = [
  { id: "vi", label: "VI", name: "Tiếng Việt" },
  { id: "en", label: "EN", name: "English" },
];

/** `?lang=en` pins the language for a link, a screenshot or a smoke run. */
function initial(): Lang {
  try {
    const q = new URLSearchParams(window.location.search).get("lang");
    if (q === "en" || q === "vi") return q;
  } catch {
    /* ignore */
  }
  return storedLang();
}

/**
 * The language this device last chose, without any hook or provider.
 *
 * `main.tsx`'s outermost error boundary sits *outside* `LocaleProvider`, and it
 * still has to say something in the reader's language. This is the same read
 * the provider does, exported so the boundary does not have to duplicate it or
 * fall back to English for a Vietnamese reader looking at a crash screen.
 */
export function storedLang(): Lang {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === "en" || stored === "vi") return stored;
  } catch {
    /* ignore */
  }
  // The product ships in Vietnamese; English is the option.
  return "vi";
}

export type Vars = Record<string, string | number>;

export function interpolate(text: string, vars?: Vars): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (whole, k: string) => (k in vars ? String(vars[k]) : whole));
}

/** Translate one English sentence. Unknown keys pass through unchanged. */
export function translate(lang: Lang, en: string, vars?: Vars): string {
  const text = lang === "vi" ? (DICT[en] ?? en) : en;
  return interpolate(text, vars);
}

/**
 * Translate the sentence a diagnostic message starts with, leaving the detail.
 *
 * The worker hooks compose `"<sentence> — <exception message>"`, where only the
 * first half is ours: the second is whatever the runtime threw, often a stack
 * frame's text in English. Translating the whole string would miss the key and
 * show the sentence untranslated; translating nothing would leave our own
 * words in English. So the split is on the em dash the hooks join with.
 */
export function translateDetail(lang: Lang, message: string): string {
  const i = message.indexOf(" — ");
  if (i < 0) return translate(lang, message);
  return `${translate(lang, message.slice(0, i))} — ${message.slice(i + 3)}`;
}

interface LocaleCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  toggleLang: () => void;
  /** Translate; the sentence itself is the key. */
  t: (en: string, vars?: Vars) => string;
  /** Translate a message's leading sentence, leaving its ` — detail` alone. */
  td: (message: string) => string;
  /** `Number.prototype.toLocaleString` in the active language's convention. */
  num: (v: number, digits?: number) => string;
}

const Ctx = createContext<LocaleCtx | null>(null);

export function LocaleProvider({
  children,
  lang: forced,
  onLang,
}: {
  children: ReactNode;
  /** Controlled mode: the caller owns the state (used by the pages' tests). */
  lang?: Lang;
  onLang?: (l: Lang) => void;
}) {
  const [own, setOwn] = useState<Lang>(initial);
  const lang = forced ?? own;

  useEffect(() => {
    document.documentElement.lang = lang;
    if (forced) return;
    try {
      localStorage.setItem(STORAGE_KEY, lang);
    } catch {
      /* ignore */
    }
  }, [lang, forced]);

  const setLang = useCallback(
    (l: Lang) => {
      if (onLang) onLang(l);
      if (!forced) setOwn(l);
    },
    [forced, onLang],
  );

  const value = useMemo<LocaleCtx>(() => {
    const t = (en: string, vars?: Vars) => translate(lang, en, vars);
    const num = (v: number, digits?: number) => {
      try {
        return v.toLocaleString(lang === "vi" ? "vi-VN" : "en-US", {
          minimumFractionDigits: digits,
          maximumFractionDigits: digits,
        });
      } catch {
        return v.toFixed(digits ?? 0);
      }
    };
    return {
      lang,
      setLang,
      toggleLang: () => setLang(lang === "vi" ? "en" : "vi"),
      t,
      td: (message: string) => translateDetail(lang, message),
      num,
    };
  }, [lang, setLang]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** The translator. Outside a provider it falls back to English, which keeps
 *  chart primitives usable in isolation. */
export function useT(): LocaleCtx {
  const ctx = useContext(Ctx);
  if (ctx) return ctx;
  return {
    lang: "en",
    setLang: () => {},
    toggleLang: () => {},
    t: (en: string, vars?: Vars) => interpolate(en, vars),
    td: (message: string) => message,
    num: (v: number, digits?: number) => v.toFixed(digits ?? 0),
  };
}

/** Tag for the language switch, used by `smoke-pages` to drive it. */
export const LANG_SWITCH_ATTR = "data-lang-switch";
