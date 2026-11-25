import { useEffect, useState } from "react";
import { readDatasetJson } from "../lib/dataset";

/**
 * Read a dataset JSON file once, for a page that renders static evidence.
 *
 * The monitor loads these through hooks that also own worker lifecycles; the
 * documentation pages only need the bytes, so this stays deliberately dumb.
 * A failed read is a string, not a thrown error: the page has to render a
 * useful message either way.
 */
export function useJson<T>(path: string): {
  data: T | null;
  error: string | null;
} {
  const [state, setState] = useState<{ data: T | null; error: string | null }>({
    data: null,
    error: null,
  });

  useEffect(() => {
    let live = true;
    readDatasetJson<T>(path)
      .then((data) => {
        if (live) setState({ data, error: null });
      })
      .catch((e: unknown) => {
        if (live) setState({ data: null, error: e instanceof Error ? e.message : String(e) });
      });
    return () => {
      live = false;
    };
  }, [path]);

  return state;
}
