// Compare MAC counts of candidate architectures at 250 samples, batch 1.
type Spec = { name: string; convs: [number, number, number][]; pools: number[] };
const specs: Spec[] = [
  {
    name: "current w16 k7/5/3/3 pool2x4",
    convs: [
      [1, 16, 7],
      [16, 32, 5],
      [32, 64, 3],
      [64, 64, 3],
    ],
    pools: [2, 2, 2, 2],
  },
  {
    name: "w16 k5/3 pool4,4,2",
    convs: [
      [1, 16, 5],
      [16, 32, 3],
      [32, 32, 3],
    ],
    pools: [4, 4, 2],
  },
  {
    name: "w12 k5/5/3 pool4,4,2",
    convs: [
      [1, 12, 5],
      [12, 24, 5],
      [24, 24, 3],
    ],
    pools: [4, 4, 2],
  },
  {
    name: "w8  k5/5/3 pool4,4,2",
    convs: [
      [1, 8, 5],
      [8, 16, 5],
      [16, 16, 3],
    ],
    pools: [4, 4, 2],
  },
  {
    name: "w16 k5/3 pool5,5 (stride5)",
    convs: [
      [1, 16, 5],
      [16, 32, 3],
    ],
    pools: [5, 5],
  },
];
for (const s of specs) {
  let L = 250,
    mac = 0;
  for (let i = 0; i < s.convs.length; i++) {
    const [ci, co, k] = s.convs[i]!;
    mac += L * ci * co * k;
    L = Math.floor(L / s.pools[i]!);
  }
  const dense = 32 * co_of(s) + 4 * 32;
  function co_of(x: Spec) {
    const c = x.convs[x.convs.length - 1]!;
    return c[1];
  }
  const tot = mac + dense;
  console.log(
    `${s.name.padEnd(36)} len_end=${String(L).padStart(3)}  MAC=${tot.toString().padStart(7)}  -> ${((tot / 721e6) * 1000).toFixed(2)} ms/beat  ${((7000 * tot) / 721e6).toFixed(1)} s/segment`,
  );
}
