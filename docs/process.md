# Process: the repository, the gate, and the rules that guard them

Status: **git exists, a commit runs the fast half of the gate, and one command
runs all of it.** This is G16, the tier of work that protects every tier before
it. Nothing here changes what the app does; it changes what is caught before it
reaches the app.

The plan for this tier named four items. Three landed and one was measured and
dropped; all four are below, with the reason.

## Why this tier exists at all

The previous fifteen milestones were verified by whoever remembered to run the
commands. That worked because there was one author and one machine. It does not
scale to a second person, and it did not scale to _this_ person either: three
defects in the project's history were found only because a suite was run again
by hand —

- a smoke flake that appeared in one run in six,
- an exe that was never rebuilt because the Tauri wrapper exited 0 anyway,
- a check that passed while asserting nothing.

None of those is a code bug. All three are a process gap: nothing was watching.

## The repository

There was no `.git` directory until G16. The tree had been living on the disk
for fifteen milestones with no history, so "what changed and why" lived in these
notes and nowhere else.

The initial commit is 248 files. What is **not** in it, and why:

| Excluded                         | Reason                                                                                                                               |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `data/`                          | 1.1 GB of PhysioNet material this project did not author; `pipeline/` rebuilds it.                                                   |
| `app/node_modules/`, `app/dist/` | Derived from the lockfile.                                                                                                           |
| `app/src-tauri/target/`, `gen/`  | Derived from `Cargo.lock`.                                                                                                           |
| `.cache/`, `logs/`               | Headless-browser profiles, npm cache, task output and one-off captures. The screenshots that are documentation are in `docs/shots/`. |
| `.env`, `.env.*`                 | The app has no secrets today; if it grows one it must not arrive through `git add -A`.                                               |
| `tsconfig.tsbuildinfo`           | `tsc`'s build cache, written next to the sources it derives from.                                                                    |
| `keys_template.json` (×2)        | Written by `check_i18n.py --write`; regenerable, and stale the moment a string changes.                                              |

The first three were easy to exclude by directory. The last two are written in
place, beside the sources they describe, so only a name rule catches them — and
the initial commit had caught three generated files and one scratch capture.
They were removed before the repository was published, with history rewritten
while the remote was still empty, because a clone should not carry an artefact
that every run then dirties.

`app/src-tauri/icons/` _is_ committed even though it is generated: the generator
is Python + Pillow, and a build should not require Pillow to reproduce an icon
that has not changed.

### Line endings

The working tree had arrived with 16 files in CRLF and 59 in LF — different
editors over fifteen milestones. `.gitattributes` sets `text=auto eol=lf` so the
index is one style regardless, and the binary types are marked so Git never
tries to normalise a `.f32` or an `.ico`.

This mattered for the next item: Prettier's default `endOfLine: "lf"` reports
every CRLF file as wholly reformatted. Measured with `--end-of-line auto`, the
real formatting delta was 1,971 lines, not the 49-files wholesaled figure that
first appeared.

### The pre-commit hook

`.githooks/pre-commit` runs the stages that finish in seconds:

```
i18n audit → format check → lint → typecheck → seven unit suites → cargo test
```

and leaves the browser suites to `npm run gate -- --browser`, because three
headless browsers per commit is a hook people disable. Install once per clone:

```
git config core.hooksPath .githooks
```

The Rust tests joined the hook in G17: a commit that changes which dataset
folder wins and is never compiled is the exact mistake the rule exists to
prevent. The cost is uneven — the first run after a Rust edit compiles the
dependency tree (~60 s), every run after that is under a second — and the hook
reports `skipped (no cargo)` rather than failing when the toolchain is absent.

It earned its place on its first run: it caught a `TS6133` (unused variable) in
code written the same session, which the editor had not flagged.

Bypass is deliberately visible — `git commit --no-verify` — rather than hidden
behind an environment variable.

### The defect the hook had on day one

The hook ran seven unit suites, and **six of them read `data/`** — four through
a hard-coded `D:/Rpeak-Desktop/data/catalog`. Since the dataset is deliberately
not in the repository, the consequence was:

- a fresh clone could not commit anything: every data-backed suite would fail
  with `ENOENT`, and the failure looks like broken code, not a missing dataset;
- a clone to any other path would read _another checkout's_ data, which is
  worse than failing — it passes on the wrong files.

Both are fixed, and verified by running the hook with and without a dataset:

```
$ RPEAK_DATA_DIR=/tmp/no-data sh .githooks/pre-commit
  test           ok
  test:detect    skipped (no dataset)
  ...
pre-commit: note -- not checked for want of a dataset: test:detect test:hrv ...
pre-commit: ok (browser suites: npm run gate -- --browser)
```

The mechanism is `app/scripts/lib/dataset.ts`, which resolves the data root from
`RPEAK_DATA_DIR` (the same variable the packaged app honours) or from the
repository's own location, never from the cwd. A suite that cannot do its work
without data prints `SKIPPED` and exits 0; the commit hook and the gate both
read that and say so, so a green gate never means "nothing was checked".

The same refactor removed every remaining hard-coded `D:/Rpeak-Desktop`: the
five smoke suites' browser profiles and their model-artefact reads, `evaluate.ts`,
`debugStages.ts`, and — the larger half — `pipeline/`. `pipeline/config.py` now
derives `ROOT` from its own file, and 34 probes that reached for the directory
with `sys.path.insert(0, "D:/Rpeak-Desktop/pipeline")` now use
`Path(__file__).resolve().parent`. `RPEAK_ROOT` overrides it for a data
directory on another drive.

`vite.config.ts` was the last place still resolving `../data` by hand, which
mattered because the dev server and the suites argue about the same files: a
smoke run under `RPEAK_DATA_DIR` would have had the scripts read one dataset
while the page they drove was served another. It resolves the same variable now,
so the setting reaches the page, the scripts and the exe.

This mattered more than it looks: a repository whose own quality gate only works
on one machine is a repository with no gate.

## `npm run gate`

`app/scripts/gate.ts` runs every stage in order and stops at the first failure.
Eighteen stages with `--browser`; thirteen without.

```
$ npm run gate -- --list
        i18n audit      Every t() key has a Vietnamese entry, and every entry is reachable.
        format          The reformat happened once; this is what stops it drifting back file by file.
        lint            A stale hook dependency, an effect with no cleanup, a promise nobody awaits.
        typecheck       The one check that catches a structural mistake before a browser does.
        i18n unit       The language layer's fallbacks, placeholders and detail split.
        ...             (seven unit suites, including the Rust precedence tests, and the bundle build)
browser smoke           Playback, workers, boundaries and the dialog behaviour, live.
browser smoke:pages     The model card, the guide and page navigation.
browser smoke:lang      The shipped default is Vietnamese, and every page follows it.
browser smoke:theme     Both palettes, measured for contrast rather than photographed.
browser smoke:app       The packaged exe, including that it was rebuilt.
```

Three design decisions worth keeping:

1. **Every stage carries its `why`**, printed by `--list` and on failure. A
   gate that fails without saying what it was protecting is a gate people turn
   off.
2. **A skipped stage is reported, not counted.** A green gate that silently
   omitted ten stages is worse than no gate, because it is a claim that is not
   true. The ten data-backed stages — five unit suites and all five browser
   suites, which derive their expected figures from `data/models/*.json` — are
   flagged `dataBacked` in the stage list, so without a dataset the gate prints
   `8/13 stages ran` (or `8/18` with `--browser`) and names what it did not
   check, rather than `all 13 passed`. A stage whose _toolchain_ is missing is
   skipped the same way: `rust unit` reports itself unavailable when `cargo` is
   not installed, because a missing compiler says nothing about the code.
3. **`--repeat N` multiplies only the timing-dependent stages.** A smoke suite
   that fails once in six runs means a green run means nothing; the repeat exists
   to make a flake visible rather than to be lenient about it.

Measured on this machine: `npm run gate -- --browser` is 88–105 s, all 18 stages
green (105 s on the G17 run, whose smoke:app adds five checks and builds a
trimmed fixture; 94 s after the language-profile fix, whose six launches now
share an empty WebView2 folder). With no dataset that same command is 29 s and
says `8/18`. The non-browser gate is 42–66 s with a dataset and 29 s without —
the spread is the bundle build and the smokes competing with whatever else is on
the CPU.

`smoke:app` drives whatever binary is on disk, and the packaging trap from G6 is
a build that exits 0 without rebuilding. The gate cannot prove the exe matches
the source, but it _can_ compare timestamps, so it warns when `rpeak.exe` is
older than `App.tsx`, `main.tsx`, `index.html` or `package.json`. That warning
fired during G16: the exe was from 08:33 and the sources from 09:16, so the
first `--browser` run drove a stale binary. Rebuilt, and `smoke:app` re-run
against it — see [packaging.md](packaging.md#reproducing).

## ESLint

`app/eslint.config.js`, ESLint 10 flat config with typed linting
(`projectService: true`), so `no-floating-promises` can tell a promise from a
value.

The rules are chosen to catch defects, not to restyle code. The two that would
have caught real defects in this project's history:

- `react-hooks/exhaustive-deps` — a hook reading a value that is not in its
  dependency list is how the model card held a stale architecture label across
  a language switch.
- an effect with no cleanup — how the scroll spy came to measure a detached
  element.

Three of the `react-hooks` preset's rules are switched off, with the reasoning in
the config file next to the line: `refs`, `purity` and `set-state-in-effect` are
prerequisites for the React Compiler, which this project does not enable. The
engine is a lazily-created object held in a ref and read only from event
handlers; the report panel renders a live elapsed time, which is deliberately a
function of the clock; and resetting state when a toggle turns off is cheaper
than deriving four pieces of state in every consumer. Turning them off is a
decision about _this_ codebase, and the config says so — if the compiler is ever
enabled, they come back first.

`npx eslint src scripts` found four errors and three warnings on first run, and
all seven were real:

| Site                               | Rule                    | What it was                                                                              |
| ---------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------- |
| `App.tsx` initial-catalogue effect | `no-floating-promises`  | an async IIFE whose failures went to `setError`; marked `void` so the intent is recorded |
| `gqrs.ts` `sm()`                   | `no-useless-assignment` | `let v = 0` where only the startup branch assigns before reading                         |
| `gqrs.ts` peak loop                | `prefer-const`          | a `let` that is never reassigned                                                         |
| `charts.tsx` key handler           | `no-useless-assignment` | `let next = at` overwritten in both branches                                             |
| `App.tsx` `delin`                  | `exhaustive-deps` ×2    | a fresh object literal per render, a dependency of two effects — now `useMemo`           |
| `ModelPage.tsx` `classes`          | `exhaustive-deps`       | a fresh fallback array per render feeding a `useMemo` — now `useMemo`                    |

The `gqrs.ts` edits are value-preserving: `npm run test:detect` still reports
every stage matching the Python reference, which is the check that would catch a
port that drifted while being tidied.

Lint is deliberately **not** in the pre-commit hook's browser half and Prettier
has no stylistic rules enabled in ESLint, so the two tools never disagree about
the same line.

## Prettier

`app/.prettierrc.json` is two lines: `printWidth: 100`, `endOfLine: "lf"`.
There is no `singleQuote`/`semi`/`trailingComma` because the defaults match what
the code already did.

The width was **measured**, not chosen:

| `printWidth` | Lines Prettier would change |
| ------------ | --------------------------- |
| 90           | 2,260                       |
| 96           | 2,008                       |
| **100**      | **1,971**                   |
| 110          | 2,182                       |
| 120          | 2,545                       |

100 is the minimum, and it is also the conventional choice, so the smallest diff
and the least surprising config agree. The reformat happened once, in the
initial commit, where there is no history to churn — the only cheap moment it
ever had.

`app/.prettierignore` excludes what is generated or not ours: `dist/`, `target/`,
the icons, `package-lock.json`, `tsconfig.tsbuildinfo`, `keys_template.json` and
`src/lib/filterCoeffs.json`. That last one is written by
`pipeline/gen_filter_coeffs.py`; formatting it would be undone the next time its
generator runs, so the gate would fail forever. It was caught by the gate itself
on its first run.

## The light theme, measured

G2 shipped the light theme with seven screenshots and no check. Every other test
in the project reads structure, numbers or behaviour; none read colour. A change
that left light-theme text at 2:1 against its own panel would have passed the
entire gate and been found by whoever next switched the theme.

`app/scripts/smoke-theme.ts` reads the _resolved_ custom properties out of the
live document in both themes, composites the panel's translucent fill over the
chart surface behind it, and computes WCAG 2.1 contrast ratios from the actual
pixels a reader gets. Twenty checks: eight samples per theme, plus three that
prove the switch did something.

It found three real regressions, all in the light theme and all invisible to
anything that is not a ratio:

| Token                  | Measured | Required               | Fixed to      |
| ---------------------- | -------- | ---------------------- | ------------- |
| `--text-faint` (light) | 2.56:1   | 3:1                    | `#64748b`     |
| `--chart-axis` (light) | 1.67:1   | 3:1 (non-text graphic) | α 0.32 → 0.65 |
| `--chart-axis` (dark)  | 1.90:1   | 3:1                    | α 0.34 → 0.65 |

One finding recorded by reading the code rather than the output: `--chart-axis`
is the cursor line, not the tick labels. The tick labels are `--text-faint` on
`--graph-bg`, which is a separate sample. A check written against the wrong
token would have measured the wrong thing and passed.

The script also confirms the light theme still paints the trace, because a
theme switch that rebuilt the palette without repainting the canvas would leave
a blank chart that no contrast ratio would notice.

## Panels are dialogs

G2–G15 rendered five panels — stats, HRV, report, classifier, segment picker —
as plain floating `div`s. They looked right and were not: a screen reader did not
announce them as a dialog, Tab walked out into the page behind them, and closing
one dropped focus to the document body.

G16 replaced them with one `components/Panel.tsx`:

- `role="dialog"`, `aria-modal="true"`, `aria-labelledby` pointing at the
  heading's `useId()`.
- A focus trap on Tab and Shift+Tab, wrapping at both ends.
- Focus moves into the panel on mount and returns to whatever opened it on
  unmount — guarded by `opener.isConnected`, because the opener may have
  unmounted with the panel.

Two things the component deliberately does **not** do:

- **It does not own Escape.** `App`'s window-level key handler already closes
  whichever panel is open, and a second handler would close it twice or close a
  different one.
- **It does not set `aria-hidden` on sibling content.** `aria-modal` is the
  declaration; a stale `aria-hidden` on an ancestor is how a whole app ends up
  hidden from assistive technology after a panel closes.

`smoke` gained four checks, and three of them initially failed for test-side
reasons that are worth recording, because each one is a way a check can lie:

1. The panel was `null` for a frame after the click — React commits a frame
   later than the synthetic event. Fixed with a poll loop.
2. "No `aria-hidden` ancestor" counted 21 nodes globally; decorative icons set
   `aria-hidden` legitimately. Fixed by walking the dialog's `parentElement`
   chain instead.
3. "Tab stays inside" ran on the Vitals panel, which has one focusable node and
   therefore proves nothing. Moved to the Segments panel (24 rows plus close).
4. "Closing returns focus" did not, because the opener was never focused — and
   then, after fixing that, because closing stats and opening segments in one
   `evaluate` let the first panel's focus restore land after the second's. Split
   into two round trips.

The rail-focus check had the same class of bug: it read `display: "block"`
before the blur it was supposed to be measuring the effect of.

## The Rust side has tests, and getting them to start was the work

G17 put the dataset-folder precedence rule in Rust, and a rule about which
folder wins is exactly the kind that must be tested: the failure mode is not a
crash but a run that quietly reads the wrong dataset. `cargo test` found 10 tests
in `src-tauri/tests/source.rs`; getting any of them to _run_ took four attempts
and one measurement.

On Windows, `cargo test` died with exit code `0xc0000139`
(`STATUS_ENTRYPOINT_NOT_FOUND`) **before printing a test name**. No Rust code had
executed, so nothing in the test's own output could say why.

The cause was a static import, three dependency layers down.
`tauri-runtime-wry` binds `comctl32!TaskDialogIndirect` under its
`common-controls-v6` feature. That export exists only when the application
manifest declares `Microsoft.Windows.Common-Controls` v6. `tauri-build` compiles
the manifest and links it via `embed-resource`, whose `compile()` emits
`cargo:rustc-link-arg-bins` — which reaches the binary and `tests/` targets, but
**not** the library's own unit-test harness (`#[cfg(test)] mod tests` inside
`lib.rs`). Without the manifest Windows binds `comctl32` to v5, which has no
v6-only entry point, and the loader stops the process before `main`.

Three measurement steps, in order, each of which changed the hypothesis:

1. `#[cfg(not(test))]` around the dialog plugin — **wrong assumption**:
   the import comes from `tauri`'s own dependency tree, not from the plugin, so
   excluding the plugin changed nothing.
2. Comparing the PE resources of the working exe and the failing test harness:
   the exe carried one Common-Controls manifest, the harness zero.
3. Reading `tauri-build`/`tauri-winres`/`embed-resource` to see which
   `cargo:rustc-link-arg*` directive reaches which target.

The fix is three lines and does not touch the app binary:

- `[lib] test = false`, `doctest = false` in `Cargo.toml` — no unit-test harness
  for the library at all;
- the tests live in `tests/source.rs`, which the manifest does reach;
- `build.rs` emits `cargo:rustc-link-arg-tests=<OUT_DIR>/libresource.a` after
  `tauri_build::build()`, conditioned on the file existing.

`cargo:rustc-link-arg=` (all targets) is the wrong spelling: it double-links
the resource into the binary, and `ld` fails with
`.rsrc merge failure: duplicate leaf: type: 3 (ICON)`. `-tests=` only works
once a `tests/` target exists — otherwise Cargo rejects it with "does not have
a test target". The app binary was checked afterwards: still exactly one
manifest.

The lesson generalises beyond Rust: **a test harness that cannot start, with an
error naming no missing symbol, is not a test failure and will not be reported
as one.** It has to be found by comparing a binary that works with one that does
not.

## A failure that was a race, not a bug — and the fix that removes the race

`smoke:app` has a check that the packaged app **ships** in Vietnamese: launch a
first-time reader's window and read the language before anything presses a
button. It failed about one run in three, always with the same detail:

```
FAIL the packaged app ships in Vietnamese -- {"lang":"en","vi":"false"}
```

The value was English because WebView2 keeps `localStorage` in a profile that
outlives the process, and the suite presses EN later in the same run. A run that
started after a run that ended in English read the previous run's choice and
called it the shipped default. So the suite reset the storage from the page and
reloaded. That is where the race came from, and three attempts at making the
reload safe all still failed roughly one run in three:

1. Set `window.__navToken` before `location.reload()` and require it gone —
   the token rejects the old document but says nothing about _when_ the new one's
   React mount effect ran, and `index.html` ships `<html lang="en">`.
2. Read until two consecutive samples agreed. Still failed: the reset expression
   itself ran before the app mounted, so `removeItem` fired into a provider whose
   mount effect then wrote `"en"` straight back from its own in-memory state.
3. Require `document.documentElement.lang === storedLang()` before removing —
   i.e. only reset once the effect had demonstrably run. This one _looks_ like it
   closes the gap, and it measured 15/15 and 8/8 in a standalone repro. In the
   suite it still failed one run in three.

The repro failing to reproduce was the useful measurement. It said the reset was
not inherently racy; something about the state a real suite run leaves behind
made it so, and no amount of waiting on the page would fix that. The right
question was not "how do I win the race" but "why is there a race at all".

There does not have to be one. The WebView2 loader honours
`WEBVIEW2_USER_DATA_FOLDER`, and pointing it at a folder made with
`mkdtempSync` gives the run a profile that has never been written to:

```
launch A (empty folder)   press EN   ->  stored "en"
launch A again                        ->  still "en"   (the folder is the profile)
launch B (second empty folder)        ->  "vi", stored "vi"   (a first-time reader)
```

So the suite now makes one empty profile per run, shares it across its six
launches, and deletes it afterwards. The reset and the reload are **gone**: there
is no earlier state to clear and no second document to read. The check measures
what it claims to — the shipped default — and eight consecutive runs passed.

Two things worth keeping from this:

- **A flaky check is usually a check whose environment is not controlled**, not
  a check that needs a longer timeout. Three waiting strategies failed because
  patience cannot fix shared state.
- **Prove the check can still fail.** With the profiles seeded by hand to hold
  `"en"`, the check reports `{"lang":"en","vi":"false"}` and only that check
  fails — the fix controls the default without making the assertion vacuous.

The profile cannot always be removed at the end: `kill()` is asynchronous and
the WebView2 helper processes outlive it by a moment with files still open, so
the first `rmSync` lost on every run (7 MB per run left in `%TEMP%`). It now
retries for five seconds and says so if it still cannot, rather than failing a
run over a temp folder.

## What was measured and dropped

The plan also listed a jump-to-row-by-name in the charts and a grouped table of
contents. Both were assessed and not built:

- **Jump to a row by name.** The charts are per-patient tables over 12 patients
  and 4 classes — every row is already reachable in one or two keypresses, and
  the G13 cursor announces "3 of 12". A search box would be a control with one
  word of content to search.
- **A grouped contents list.** The model card has 10 entries; grouping them
  would add a level of nesting for a list that fits on one screen.

Both stay listed here rather than silently vanishing, because "we decided not to"
is different from "we forgot".

## What is still not done

- **No code signing.** The installer is unsigned and Windows SmartScreen warns
  on first run. Signing needs a certificate this project does not have.
- **The WebView2 missing path is unexercised.** The runtime ships with Windows
  11 and recent Windows 10; this machine has it, so the download-bootstrapper
  branch has never run.
- **Windows x64 only.** The same source should build for macOS and Linux with
  their own toolchains; none of that was tried.
- **No CI.** The hook and the gate are local. A GitHub Actions workflow would
  run the same stages on a clean machine, which would prove the stages do not
  depend on this machine's state — but it cannot be written and verified here.
- **The detector's 99% gate is still not met** (Se 97.73 / PPV 96.21). That is
  measured and rejected, not pending; see [detector.md](detector.md).
