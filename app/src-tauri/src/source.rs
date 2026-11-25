//! Where the dataset is, decided without touching the window or the page.
//!
//! Everything here is a pure function of paths: no Tauri handle, no filesystem
//! event, no global process state. That is deliberate. The precedence rule is
//! the part of this feature a person is most likely to get wrong (an
//! environment variable that silently loses to a remembered choice would make
//! every scripted run test a different dataset than it was told to), so it has
//! to be testable without a window — and it is, from `tests/source.rs`.
//!
//! The reason that test lives in `tests/` rather than beside this code is a
//! Windows linking failure, recorded in `build.rs`: the library's unit-test
//! executable links `tauri`, which imports `comctl32!TaskDialogIndirect`, and
//! that export exists only under Common-Controls v6 — declared by the
//! application manifest, which `tauri-build` links into binaries and test
//! targets but not into the library's own unit-test harness.

use std::path::{Component, Path, PathBuf};

use serde::Serialize;

/// Which rule produced the current root. Serialized for the UI to name.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Origin {
    /// `RPEAK_DATA_DIR`.
    Env,
    /// The folder the user picked, remembered in `source.json`.
    Chosen,
    /// `<folder containing the exe>/data`, the portable layout.
    BesideExe,
    /// `%LOCALAPPDATA%\Rpeak\data`.
    LocalAppData,
    /// The repository's `data/` — debug builds only.
    RepoDebug,
    /// Nothing was found; `path` is where the app would look.
    None,
}

/// What the UI needs to describe the current root honestly.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSource {
    pub path: String,
    pub origin: Origin,
    /// The remembered choice that is **not** the one in force: because the
    /// environment variable beat it, or because the folder is gone. Kept and
    /// reported rather than deleted, because both are things only the user can
    /// act on, and "the folder you picked is not what you are reading" is a
    /// different message from "nothing has ever been chosen".
    pub remembered: Option<String>,
    /// Non-fatal gaps: the folder is a dataset, but something is missing from
    /// it. The app still starts, and the UI says what will not work.
    pub warnings: Vec<String>,
}

/// The inputs to root resolution, separated from `std::env` so the order can be
/// tested without changing the process environment (which is global and races
/// between tests).
#[derive(Default)]
pub struct Candidates {
    pub env: Option<PathBuf>,
    pub stored: Option<PathBuf>,
    pub beside_exe: Option<PathBuf>,
    pub local_app_data: Option<PathBuf>,
    pub repo_debug: Option<PathBuf>,
}

/// Resolution order. Each arm answers a different question:
///
/// 1. `RPEAK_DATA_DIR` — an operator pointing a build at a dataset elsewhere.
///    Deliberately first: it must be able to win over a remembered choice, or
///    `smoke:app` and any scripted run would silently test a different dataset
///    than the one they were told to.
/// 2. The user's remembered choice.
/// 3. `<exe dir>/data` — the portable layout: copy the folder next to the exe.
/// 4. `%LOCALAPPDATA%\Rpeak\data` — the per-user location for an installed
///    copy, which is where a user who does not want to touch the install
///    directory would naturally put 1 GB of ECG.
/// 5. The repository's `data/` during `tauri dev`, so development needs no
///    environment variable at all. `CARGO_MANIFEST_DIR` is baked in at compile
///    time, so this arm cannot exist in a shipped binary built elsewhere — and
///    it is only consulted in debug builds anyway.
///
/// Returns the root, its origin, and the remembered choice that is **not** in
/// force — reported even when the environment variable overrode a perfectly
/// good one, because a preference silently overridden is a lie by omission.
pub fn resolve_from(c: &Candidates) -> (PathBuf, Origin, Option<String>) {
    // What the caller should be told about `stored`, given whether it is in use.
    let remembered = |in_force: bool| {
        if in_force {
            None
        } else {
            c.stored.as_ref().map(|p| p.display().to_string())
        }
    };

    if let Some(p) = c.env.as_ref() {
        if p.is_dir() {
            return (p.clone(), Origin::Env, remembered(false));
        }
        eprintln!("RPEAK_DATA_DIR is set but is not a directory: {}", p.display());
    }

    if let Some(p) = c.stored.as_ref() {
        if p.is_dir() {
            return (p.clone(), Origin::Chosen, remembered(true));
        }
    }

    if let Some(p) = c.beside_exe.as_ref() {
        if p.is_dir() {
            return (p.clone(), Origin::BesideExe, remembered(false));
        }
    }
    if let Some(p) = c.local_app_data.as_ref() {
        if p.is_dir() {
            return (p.clone(), Origin::LocalAppData, remembered(false));
        }
    }
    if let Some(p) = c.repo_debug.as_ref() {
        if p.is_dir() {
            return (
                p.canonicalize().unwrap_or_else(|_| p.clone()),
                Origin::RepoDebug,
                remembered(false),
            );
        }
    }

    // Nothing found. Return the portable location anyway: `data_source` reports
    // it and the UI explains what is missing, which is a better failure than
    // exiting silently on launch.
    let fallback = c.beside_exe.clone().unwrap_or_else(|| PathBuf::from("data"));
    (fallback, Origin::None, remembered(false))
}

/// Reject a folder that is not a dataset, and name what is missing.
///
/// `is_dir()` is not enough: a user who picks `C:\Users\me` gets a folder that
/// exists and no data, and "not a directory" would be a false message. The
/// sentinel is the same one `app/scripts/lib/dataset.ts` uses, so the app and
/// its suites agree on what "has a dataset" means.
pub fn check_root(p: &Path) -> Result<Vec<String>, String> {
    if !p.is_absolute() {
        return Err(format!("{}: not an absolute path", p.display()));
    }
    if !p.is_dir() {
        return Err(format!("{}: not a folder", p.display()));
    }

    let catalog = p.join("catalog").join("segments.json");
    // Reading the file, not just stat-ing it, is what actually proves the
    // process may read this folder.
    let text = std::fs::read_to_string(&catalog).map_err(|e| {
        format!(
            "{}: {e}\nNo catalog/segments.json here — this is the dataset folder, not an app folder. \
             Build one with pipeline/export_app_index.py.",
            catalog.display()
        )
    })?;
    match serde_json::from_str::<Vec<serde_json::Value>>(&text) {
        Ok(v) if !v.is_empty() => {}
        Ok(_) => return Err(format!("{}: the catalogue is empty", catalog.display())),
        Err(e) => return Err(format!("{}: {e}", catalog.display())),
    }

    let mut warnings = Vec::new();
    if !p.join("models").join("beatcnn.json").is_file() {
        warnings.push("models/beatcnn.json".to_string());
    }
    Ok(warnings)
}

/// Build the `DataSource` for a resolved root.
pub fn describe(path: &Path, origin: Origin, remembered: Option<String>) -> DataSource {
    let warnings = match origin {
        // Already validated when it was chosen; re-reading is cheap and keeps
        // the reported warnings true after the folder changes on disk.
        Origin::None => Vec::new(),
        _ => check_root(path).unwrap_or_default(),
    };
    DataSource {
        path: path.display().to_string(),
        origin,
        remembered,
        warnings,
    }
}

/// Reject any request that is not a plain relative path.
///
/// The frontend is trusted, but a path that arrives from a URL parameter or a
/// future feature is not, and one `..` would expose the whole disk. Rejecting
/// components outright is stricter than canonicalising afterwards: it cannot be
/// defeated by a symlink created between the check and the read.
pub fn safe_relative(path: &str) -> Option<PathBuf> {
    let rel = path.trim_start_matches('/');
    if rel.is_empty() {
        return None;
    }
    let mut out = PathBuf::new();
    for c in Path::new(rel).components() {
        match c {
            Component::Normal(part) => out.push(part),
            // CurDir is harmless but pointless; anything else (ParentDir, RootDir,
            // Prefix) is an escape attempt.
            Component::CurDir => {}
            _ => return None,
        }
    }
    if out.as_os_str().is_empty() {
        None
    } else {
        Some(out)
    }
}
