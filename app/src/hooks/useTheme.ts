import { useCallback, useEffect, useState } from "react";

export type Theme = "dark" | "light";

const STORAGE_KEY = "rpeak.theme";

function initial(): Theme {
  // ?theme=light wins over the stored preference so a screenshot, a bookmark
  // or a link to a colleague can pin the appearance.
  try {
    const q = new URLSearchParams(window.location.search).get("theme");
    if (q === "light" || q === "dark") return q;
  } catch {
    /* ignore */
  }
  try {
    return localStorage.getItem(STORAGE_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

/**
 * Theme lives on <html data-theme>, which is what the CSS variables key off.
 * Persisting it is a per-device convenience only, so localStorage is the right
 * place -- and every access is guarded because it throws in private windows.
 */
export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(initial);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(STORAGE_KEY, theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((t) => (t === "dark" ? "light" : "dark"));
  }, []);

  return [theme, toggle];
}
