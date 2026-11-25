import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import path from "node:path";

/**
 * The ECG catalogue lives outside the app root so the same bytes are shared by
 * the Python pipeline, the offline evaluator and the app. Vite will not serve
 * outside its root by default, so mount it at /data.
 *
 * The location follows the same rule as `scripts/lib/dataset.ts` and the
 * packaged app: `RPEAK_DATA_DIR` if set, otherwise `<repo>/data`. It used to be
 * a bare `../data`, which meant the dev server and the suites could disagree
 * about which dataset they were testing.
 *
 * Range requests are honoured: the 4 MB f32 files load fine in one request,
 * but range support keeps `curl` and any future streaming source honest.
 */
const DATA_ROOT = path.resolve(
  process.env.RPEAK_DATA_DIR ?? fileURLToPath(new URL("../data", import.meta.url)),
);

function serveDataset(): Plugin {
  const handler = (
    req: { url?: string; headers: Record<string, string | string[] | undefined> },
    res: import("node:http").ServerResponse,
    next: (err?: unknown) => void,
  ) => {
    const url = req.url ?? "";
    if (!url.startsWith("/data/")) return next();

    const rel = decodeURIComponent(url.slice("/data/".length).split("?")[0]);
    const abs = path.resolve(DATA_ROOT, rel);
    // Confine every request to the data directory even if the path tries to
    // escape with ../ sequences.
    if (abs !== DATA_ROOT && !abs.startsWith(DATA_ROOT + path.sep)) {
      res.statusCode = 403;
      res.end("forbidden");
      return;
    }

    fs.stat(abs, (err, st) => {
      if (err || !st.isFile()) {
        res.statusCode = 404;
        res.end("not found");
        return;
      }

      const type = abs.endsWith(".json")
        ? "application/json; charset=utf-8"
        : abs.endsWith(".f32")
          ? "application/octet-stream"
          : "application/octet-stream";
      res.setHeader("Content-Type", type);
      res.setHeader("Accept-Ranges", "bytes");
      res.setHeader("Cache-Control", "public, max-age=3600");

      const range = req.headers.range;
      const m = typeof range === "string" ? /^bytes=(\d*)-(\d*)$/.exec(range) : null;
      if (m) {
        const start = m[1] ? Number(m[1]) : 0;
        const end = m[2] ? Number(m[2]) : st.size - 1;
        if (start >= st.size || end >= st.size || start > end) {
          res.statusCode = 416;
          res.setHeader("Content-Range", `bytes */${st.size}`);
          res.end();
          return;
        }
        res.statusCode = 206;
        res.setHeader("Content-Range", `bytes ${start}-${end}/${st.size}`);
        res.setHeader("Content-Length", end - start + 1);
        fs.createReadStream(abs, { start, end }).pipe(res);
        return;
      }

      res.setHeader("Content-Length", st.size);
      fs.createReadStream(abs).pipe(res);
    });
  };

  return {
    name: "rpeak-serve-dataset",
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}

export default defineConfig({
  plugins: [react(), serveDataset()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 5173,
    strictPort: false,
    fs: { allow: [path.resolve(fileURLToPath(new URL("..", import.meta.url)))] },
  },
  // Never bundle the dataset into the build.
  publicDir: false,
});
