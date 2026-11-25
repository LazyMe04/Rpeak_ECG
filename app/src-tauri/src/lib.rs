//! Rpeak Desktop shell.
//!
//! The UI is the same Vite app the browser runs; this crate adds the two things
//! a browser cannot do and a desktop app must:
//!
//!   * **Serve the dataset from disk.** In development Vite middleware mounts
//!     `D:\Rpeak-Desktop\data` at `/data`. A packaged app has no Node server, so
//!     `read_dataset` reads the bytes here and the frontend swaps its `fetch`
//!     for an `invoke`. See `app/src/lib/dataset.ts` for the browser side.
//!   * **Find the dataset without being told.** Resolved once at startup and
//!     reported through `data_dir` so the UI can say where it is looking when a
//!     folder is missing.
//!
//! Nothing else is exposed. There is no shell plugin, no filesystem plugin, no
//! HTTP client: the app reads one directory and runs arithmetic.

use std::path::{Component, Path, PathBuf};

use tauri::Manager;

/// Where the dataset lives, resolved once at startup.
struct DataRoot(PathBuf);

/// Resolve the dataset directory.
///
/// Order matters, and each entry answers a different question:
///
/// 1. `RPEAK_DATA_DIR` — an operator pointing a build at a dataset elsewhere.
/// 2. `<exe dir>/data` — the portable layout: copy the folder next to the exe.
/// 3. `%LOCALAPPDATA%\Rpeak\data` — the per-user location for an installed
///    copy, which is where a user who does not want to touch the install
///    directory would naturally put 1 GB of ECG.
/// 4. The repository's `data/` during `tauri dev`, so development needs no
///    environment variable at all. `CARGO_MANIFEST_DIR` is baked in at compile
///    time, so this arm cannot exist in a shipped binary that was built
///    elsewhere — and it is only consulted in debug builds anyway.
fn resolve_root() -> PathBuf {
    if let Ok(p) = std::env::var("RPEAK_DATA_DIR") {
        let p = PathBuf::from(p);
        if p.is_dir() {
            return p;
        }
        eprintln!("RPEAK_DATA_DIR is set but is not a directory: {}", p.display());
    }

    if let Ok(exe) = std::env::current_exe() {
        if let Some(dir) = exe.parent() {
            let beside = dir.join("data");
            if beside.is_dir() {
                return beside;
            }
        }
    }

    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let per_user = PathBuf::from(local).join("Rpeak").join("data");
        if per_user.is_dir() {
            return per_user;
        }
    }

    if cfg!(debug_assertions) {
        let repo = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data");
        if repo.is_dir() {
            return repo.canonicalize().unwrap_or(repo);
        }
    }

    // Nothing found. Return the portable location anyway: `data_dir` reports it
    // and the UI explains what is missing, which is a better failure than
    // exiting silently on launch.
    std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.join("data")))
        .unwrap_or_else(|| PathBuf::from("data"))
}

/// Reject any request that is not a plain relative path.
///
/// The frontend is trusted, but a path that arrives from a URL parameter or a
/// future feature is not, and one `..` would expose the whole disk. Rejecting
/// components outright is stricter than canonicalising afterwards: it cannot be
/// defeated by a symlink created between the check and the read.
fn safe_relative(path: &str) -> Option<PathBuf> {
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

#[tauri::command]
fn data_dir(root: tauri::State<DataRoot>) -> String {
    root.0.display().to_string()
}

/// Read a file from the dataset directory, relative to its root.
///
/// Returns raw bytes rather than a JSON array: the 4 MB signal files cross this
/// boundary once per segment, and Tauri's IPC sends `Response` payloads as
/// binary instead of base64. The frontend turns the bytes into a Float32Array.
#[tauri::command]
fn read_dataset(path: String, root: tauri::State<DataRoot>) -> Result<tauri::ipc::Response, String> {
    let rel = safe_relative(&path).ok_or_else(|| format!("unsafe path: {path}"))?;
    let abs = root.0.join(&rel);

    // A file that escapes through a symlink still has to land inside the root.
    let real_root = root.0.canonicalize().map_err(|e| e.to_string())?;
    let real = abs
        .canonicalize()
        .map_err(|_| format!("not found: {}", rel.display()))?;
    if !real.starts_with(&real_root) {
        return Err(format!("outside the dataset directory: {}", rel.display()));
    }

    let bytes = std::fs::read(&real).map_err(|e| format!("{}: {e}", rel.display()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// The size the UI is designed for, in logical pixels.
const WINDOW_W: f64 = 1400.0;
const WINDOW_H: f64 = 880.0;

/// Shrink the window until it fits the monitor's work area.
///
/// `tauri.conf.json` asks for 1400×880, which is right on a 1920×1080 screen at
/// 100% and wrong on the same screen at 125%: the window becomes 1750×1100
/// physical pixels against a 1042-pixel work area, Windows anchors it at the
/// top-left, and the bottom 58 px — the transport bar, the control the app is
/// driven with — end up below the taskbar. Nothing reports that: the DOM is
/// correct, the page is 1400×880, and a screenshot of the *page* looks perfect.
/// Only the window on the desktop is wrong, which is why this is checked here
/// and not in the UI.
///
/// The budget comes from `Monitor::work_area`, which already excludes the
/// taskbar; the window frame (title bar, borders) is measured as
/// `outer_size - inner_size` and taken out too, because `set_size` sets the
/// client area.
fn fit_to_work_area(win: &tauri::WebviewWindow) -> tauri::Result<()> {
    let Some(monitor) = win.current_monitor()? else {
        return Ok(());
    };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();

    let outer = win.outer_size()?;
    let inner = win.inner_size()?;
    let frame_w = outer.width.saturating_sub(inner.width) as f64;
    let frame_h = outer.height.saturating_sub(inner.height) as f64;

    let avail_w = (area.size.width as f64 - frame_w) / scale;
    let avail_h = (area.size.height as f64 - frame_h) / scale;

    let w = WINDOW_W.min(avail_w);
    let h = WINDOW_H.min(avail_h);
    if w < WINDOW_W || h < WINDOW_H {
        eprintln!(
            "rpeak: work area {:.0}x{:.0} logical, window fitted to {w:.0}x{h:.0}",
            avail_w, avail_h
        );
        win.set_size(tauri::LogicalSize::new(w, h))?;
        win.center()?;
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let root = resolve_root();
    eprintln!("rpeak: dataset at {}", root.display());

    tauri::Builder::default()
        .manage(DataRoot(root))
        .invoke_handler(tauri::generate_handler![read_dataset, data_dir])
        .setup(|app| {
            let Some(window) = app.get_webview_window("main") else {
                return Ok(());
            };

            // Surface a missing dataset in the window title rather than only on
            // stderr, which a packaged app has no console to show.
            if !app.state::<DataRoot>().0.is_dir() {
                let _ = window.set_title("Rpeak — dataset folder not found");
            }

            // The window is created hidden (`"visible": false`) so the resize
            // happens before the first frame the user sees; otherwise a small
            // screen shows the full-size window for a frame and then a jump.
            if let Err(e) = fit_to_work_area(&window) {
                eprintln!("rpeak: could not fit the window to the screen: {e}");
            }
            window.show()?;
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running the Rpeak window");
}
