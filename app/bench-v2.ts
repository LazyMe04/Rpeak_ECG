import { forward } from "./src/lib/ecg/cnn";
import type { CnnDoc, ConvBlock } from "./src/lib/ecg/cnn";
function rnd(n: number) {
  return Array.from({ length: n }, () => Math.random() * 0.2 - 0.1);
}
function convW(cout: number, cin: number, k: number) {
  return Array.from({ length: cout }, () => Array.from({ length: cin }, () => rnd(k)));
}
function mk(w: number, spec: [number, number, number, number][]): ConvBlock[] {
  return spec.map(([cin, cout, k, pool]) => ({
    conv: { w: convW(cout, cin, k), b: rnd(cout) },
    act: "relu",
    pool,
  }));
}
const specs: [string, [number, number, number, number][]][] = [
  [
    "w16 k5/5/3 pool4,4,2",
    [
      [1, 16, 5, 4],
      [16, 32, 5, 4],
      [32, 32, 3, 2],
    ],
  ],
  [
    "w24 k5/5/3 pool4,4,2",
    [
      [1, 24, 5, 4],
      [24, 48, 5, 4],
      [48, 48, 3, 2],
    ],
  ],
  [
    "w16 k5/3  pool4,4,2 ",
    [
      [1, 16, 5, 4],
      [16, 32, 3, 4],
      [32, 32, 3, 2],
    ],
  ],
  [
    "w16 k5/3  pool5,5   ",
    [
      [1, 16, 5, 4],
      [16, 32, 3, 4],
      [32, 32, 3, 2],
    ],
  ],
];
for (const [name, spec] of specs) {
  const last = spec[spec.length - 1]!;
  const doc: CnnDoc = {
    version: 1,
    window: 250,
    fs: 250,
    pre: 100,
    classes: ["N", "S", "V", "Q"],
    norm: { method: "x", core: [-50, 100], floor: 1e-6 },
    blocks: mk(last[1], spec),
    head: [
      { w: Array.from({ length: 32 }, () => rnd(last[1])), b: rnd(32), act: "relu" },
      { w: Array.from({ length: 4 }, () => rnd(32)), b: rnd(4), act: null },
    ],
  };
  const x = new Float32Array(250).map(() => Math.random());
  for (let i = 0; i < 20; i++) forward(doc, x);
  const N = 500,
    t = performance.now();
  for (let i = 0; i < N; i++) forward(doc, x);
  const ms = performance.now() - t;
  console.log(
    `${name}  ${(ms / N).toFixed(3)} ms/beat  -> ${((7000 * ms) / N / 1000).toFixed(1)} s/segment`,
  );
}
