"""G5 model: a small 1-D CNN over a single beat window.

Deliberately small, for a measured reason. The app runs inference over every
beat of a 70-minute segment (~7,000) on the main browser thread's worker, with
no GPU and no inference engine, so the budget is set by a scalar JS loop:
measured raw scalar throughput in this environment is ~721 MMAC/s, and the
budget chosen here is ~225k MAC per window, i.e. ~0.5-0.8 ms/beat and ~5 s per
segment. An earlier 4-block/1.1M-MAC design cost 34 s per segment, which is not
a classifier a reviewer will wait for.

The architecture mirrors the reference app's stated shape ("4-layer 1D CNN,
batch norm, dropout, global pooling, dense layers, softmax") in kind, with the
layer count and pool sizes chosen for the budget above.

The exported artefact is plain JSON of weight tensors. No ONNX runtime is
installed here, and the app is a Vite/React bundle that should stay importable
without a third-party engine, so inference is a hand-written forward pass in
TypeScript (`app/src/lib/ecg/cnn.ts`). That works only because the architecture
is fixed here and mirrored there; `scripts/test-cnn.ts` compares the logits of
both implementations on windows neither trained on.

Layout (input 1 x 250, plus `extra_dim` scalars):
  Block(1  -> 16, k=5, pool=4)   250 -> 62
  Block(16 -> 32, k=5, pool=4)    62 -> 15
  Block(32 -> 32, k=3, pool=2)    15 -> 7
  global average pool -> 32
  concat the extra inputs -> 32 + extra_dim
  dropout -> dense -> 32 (ReLU) -> dense 32 -> 4 -> softmax

The extras are the information a 1 s window cannot hold. Two were tried:

  * `log(scale)`, the amplitude the per-window normalisation divides away.
    Added in G8 with a good argument (Q vs N AUC 0.615) and an ablation that
    showed the network ignores it -- the conv stack already sees noise as a
    noisy shape.
  * the three timing ratios from `build_beats.rr_ratios` (G9). A beat's
    prematurity is invisible in the window and plainly visible in the peak
    train, so this is the input that has nowhere else to come from.
"""
from __future__ import annotations

import torch
import torch.nn as nn

# Kept in one place because the TypeScript side hard-codes the same numbers in
# its parity test; a change here without one there fails that test.
ARCH = [
    # (cin, cout, k, pool)
    (1, 16, 5, 4),
    (16, 32, 5, 4),
    (32, 32, 3, 2),
]
HIDDEN = 32


class Block(nn.Module):
    def __init__(self, cin: int, cout: int, k: int, pool: int) -> None:
        super().__init__()
        self.conv = nn.Conv1d(cin, cout, k, padding=k // 2, bias=False)
        self.bn = nn.BatchNorm1d(cout)
        self.act = nn.ReLU(inplace=True)
        self.pool = nn.MaxPool1d(pool) if pool > 1 else nn.Identity()

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.pool(self.act(self.bn(self.conv(x))))


class BeatCNN(nn.Module):
    def __init__(self, n_classes: int = 4, dropout: float = 0.3,
                 extra_dim: int = 1) -> None:
        super().__init__()
        layers: list[nn.Module] = []
        for cin, cout, k, pool in ARCH:
            layers.append(Block(cin, cout, k, pool))
        self.features = nn.Sequential(*layers)
        self.extra_dim = extra_dim
        self.drop = nn.Dropout(dropout)
        self.head = nn.Sequential(
            nn.Linear(ARCH[-1][1] + extra_dim, HIDDEN),
            nn.ReLU(inplace=True),
            nn.Dropout(dropout),
            nn.Linear(HIDDEN, n_classes),
        )

    def forward(self, x: torch.Tensor, extra: torch.Tensor | None = None) -> torch.Tensor:
        if x.dim() == 2:  # (batch, 250) -> (batch, 1, 250)
            x = x.unsqueeze(1)
        h = self.features(x).mean(dim=2)  # global average pool
        if self.extra_dim:
            if extra is None:
                raise ValueError(f"model takes {self.extra_dim} extra input(s) but none was given")
            if extra.dim() == 1:
                extra = extra.unsqueeze(1)
            h = torch.cat([h, extra], dim=1)
        return self.head(self.drop(h))


def count_params(model: nn.Module) -> int:
    return sum(p.numel() for p in model.parameters() if p.requires_grad)
