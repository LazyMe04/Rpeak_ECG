import { forward } from "./src/lib/ecg/cnn";
import type { CnnDoc } from "./src/lib/ecg/cnn";
function rnd(n: number) {
  return Array.from({ length: n }, () => Math.random() * 0.2 - 0.1);
}
function convW(cout: number, cin: number, k: number) {
  return Array.from({ length: cout }, () => Array.from({ length: cin }, () => rnd(k)));
}
const doc: CnnDoc = {
  version: 1,
  window: 250,
  fs: 250,
  pre: 100,
  classes: ["N", "S", "V", "Q"],
  norm: { method: "x", core: [-50, 100], floor: 1e-6 },
  blocks: [
    { conv: { w: convW(16, 1, 7), b: rnd(16) }, act: "relu", pool: 2 },
    { conv: { w: convW(32, 16, 5), b: rnd(32) }, act: "relu", pool: 2 },
    { conv: { w: convW(64, 32, 3), b: rnd(64) }, act: "relu", pool: 2 },
    { conv: { w: convW(64, 64, 3), b: rnd(64) }, act: "relu", pool: 2 },
  ],
  head: [
    { w: Array.from({ length: 32 }, () => rnd(64)), b: rnd(32), act: "relu" },
    { w: Array.from({ length: 4 }, () => rnd(32)), b: rnd(4), act: null },
  ],
};
const x = new Float32Array(250).map(() => Math.random());
for (let i = 0; i < 5; i++) forward(doc, x);
const N = 200;
const t = performance.now();
for (let i = 0; i < N; i++) forward(doc, x);
const ms = performance.now() - t;
console.log(`${N} beats in ${ms.toFixed(0)} ms -> ${(ms / N).toFixed(3)} ms/beat`);
console.log(`7000 beats -> ${((7000 * ms) / N / 1000).toFixed(2)} s`);
