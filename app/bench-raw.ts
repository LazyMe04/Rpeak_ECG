// Raw achievable scalar matmul throughput in this Node build.
const N = 1_100_000;
const a = new Float32Array(N).map(() => Math.random());
const b = new Float32Array(N).map(() => Math.random());
let acc = 0;
for (let r = 0; r < 3; r++) acc += a[0]!;
const t = performance.now();
const REPS = 200;
let s = 0;
for (let r = 0; r < REPS; r++) {
  let t0 = 0;
  for (let i = 0; i < N; i++) t0 += a[i]! * b[i]!;
  s += t0;
}
const ms = performance.now() - t;
console.log(`${REPS} reps x ${N} MAC in ${ms.toFixed(0)} ms`);
console.log(`${((REPS * N) / ms / 1e3).toFixed(2)} MMAC in ${(ms / REPS).toFixed(2)} ms/beat`);
console.log("checksum", s.toFixed(0));
