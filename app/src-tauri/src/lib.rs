//! Rpeak Desktop shell.
//!
//! The UI is the same Vite app the browser runs; this crate adds the two things
//! a browser cannot do and a desktop app must:
//!
//!   * **Serve the dataset from disk.** In development Vite middleware mounts
//!     `RPEAK_DATA_DIR` (or the repository's `data/`) at `/data`. A packaged app
//!     has no Node server, so `read_dataset` reads the bytes here and the
//!     frontend swaps its `fetch` for an `invoke`. See `app/src/lib/dataset.ts`
//!     for the browser side.
//!   * **Find the dataset without being told.** Resolved at startup and
//!     reported through `data_source` so the UI can say where it is looking.
//!
//! The choice of root is the user's, not only the operator's: `choose_data_root`
//! opens a folder picker and remembers the answer, so a downloaded build can be
//! pointed at a dataset without an environment variable. The precedence rule is
//! `RPEAK_DATA_DIR` > remembered choice > the automatic locations, and the UI
//! names which one is in force — a preference silently overridden by an
//! environment variable would be a lie by omission.
//!
//! Where the root is and whether a folder is a dataset is decided in
//! [`source`], which has no Tauri handle and is testable on its own (from
//! `tests/source.rs`; `build.rs` explains why not from beside it).
//!
//! Nothing else is exposed. There is no shell plugin, no filesystem plugin, no
//! HTTP client: the app reads one directory and runs arithmetic. The one plugin
//! here exists for its native folder dialog, and it is called from Rust, so no
//! dialog command is reachable from the page.

pub mod source;

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::Manager;
use tauri_plugin_dialog::DialogExt;

use source::{check_root, describe, resolve_from, safe_relative, Candidates, DataSource, Origin};

/// Where the dataset lives, resolved at startup and replaced when the user
/// chooses another folder. `read_dataset` reads for the whole session, so the
/// lock is never held across that I/O.
struct DataRoot {
    path: Mutex<PathBuf>,
    origin: Mutex<Origin>,
    /// The remembered choice that is not in force: either the environment
    /// variable beat it, or the folder is gone. Mutable because adopting a
    /// folder makes the old notice false — leaving it set would tell the user
    /// their earlier choice is gone in the same breath as accepting a new one.
    remembered: Mutex<Option<String>>,
    env: Option<PathBuf>,
}

fn current(state: &DataRoot) -> (PathBuf, Origin) {
    (
        state.path.lock().unwrap().clone(),
        *state.origin.lock().unwrap(),
    )
}

/// The file that remembers a chosen root.
fn store_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_config_dir()
        .ok()
        .map(|d| d.join("source.json"))
}

/// Read the remembered root. A corrupt or absent file is not an error: it means
/// no choice has been made, and the app must still start.
fn load_stored(app: &tauri::AppHandle) -> Option<PathBuf> {
    let raw = std::fs::read_to_string(store_path(app)?).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    v.get("root")?.as_str().map(PathBuf::from)
}

fn save_stored(app: &tauri::AppHandle, root: Option<&Path>) -> Result<(), String> {
    let path = store_path(app).ok_or("no config directory")?;
    match root {
        Some(p) => {
            if let Some(dir) = path.parent() {
                std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
            }
            let body = serde_json::json!({ "root": p.display().to_string() });
            let text = serde_json::to_string_pretty(&body).map_err(|e| e.to_string())?;
            std::fs::write(&path, text).map_err(|e| format!("{}: {e}", path.display()))
        }
        // Removing a preference that does not exist is success, not failure.
        None => match std::fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("{}: {e}", path.display())),
        },
    }
}

#[tauri::command]
fn data_source(state: tauri::State<DataRoot>) -> DataSource {
    let (path, origin) = current(&state);
    let remembered = state.remembered.lock().unwrap().clone();
    describe(&path, origin, remembered)
}

/// Read a file from the dataset directory, relative to its root.
///
/// Returns raw bytes rather than a JSON array: the 4 MB signal files cross this
/// boundary once per segment, and Tauri's IPC sends `Response` payloads as
/// binary instead of base64. The frontend turns the bytes into a Float32Array.
#[tauri::command]
fn read_dataset(path: String, root: tauri::State<DataRoot>) -> Result<tauri::ipc::Response, String> {
    let rel = safe_relative(&path).ok_or_else(|| format!("unsafe path: {path}"))?;
    // Copy the root out and release the lock: the read below is 4 MB, and the
    // folder picker must not wait for it.
    let base = root.path.lock().unwrap().clone();
    let abs = base.join(&rel);

    // A file that escapes through a symlink still has to land inside the root.
    let real_root = base.canonicalize().map_err(|e| e.to_string())?;
    let real = abs
        .canonicalize()
        .map_err(|_| format!("not found: {}", rel.display()))?;
    if !real.starts_with(&real_root) {
        return Err(format!("outside the dataset directory: {}", rel.display()));
    }

    let bytes = std::fs::read(&real).map_err(|e| format!("{}: {e}", rel.display()))?;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Point the session at `p`, after checking it is a dataset.
///
/// The caller reloads the page afterwards; nothing is swapped underneath a
/// running worker, which is what keeps every in-flight result tied to the
/// segment it was computed from.
fn adopt(app: &tauri::AppHandle, state: &DataRoot, p: &Path) -> Result<DataSource, String> {
    let warnings = check_root(p)?;
    // Store before adopting: if the choice cannot be remembered, the user
    // should hear about it now rather than after a reload that forgets it.
    save_stored(app, Some(p))?;
    *state.path.lock().unwrap() = p.to_path_buf();
    *state.origin.lock().unwrap() = Origin::Chosen;
    // The old "your folder is gone" notice described a choice that no longer
    // applies; the folder in hand is now the one the user asked for.
    *state.remembered.lock().unwrap() = None;
    Ok(DataSource {
        path: p.display().to_string(),
        origin: Origin::Chosen,
        remembered: None,
        warnings,
    })
}

/// Set the root from a path the caller supplies. No dialog.
///
/// The page cannot reach a native picker from a test, so this is the path every
/// automated check drives; the picker below is only the way a person supplies
/// the same string.
#[tauri::command]
fn set_data_root(
    path: String,
    app: tauri::AppHandle,
    state: tauri::State<DataRoot>,
) -> Result<DataSource, String> {
    adopt(&app, &state, Path::new(&path))
}

/// Open a native folder picker and adopt the result. `None` means cancelled.
#[tauri::command]
async fn choose_data_root(
    app: tauri::AppHandle,
    state: tauri::State<'_, DataRoot>,
) -> Result<Option<DataSource>, String> {
    let start = current(&state).0;
    let (tx, mut rx) = tauri::async_runtime::channel(1);
    app.dialog()
        .file()
        .set_title("Choose the Rpeak dataset folder")
        .set_directory(&start)
        .pick_folder(move |picked| {
            // Capacity is one and nothing else sends, so this cannot block even
            // if the receiver was dropped.
            let _ = tx.try_send(picked);
        });

    let picked = rx.recv().await.ok_or("the folder dialog closed unexpectedly")?;
    let Some(fp) = picked else {
        return Ok(None);
    };
    let path = fp.into_path().map_err(|e| e.to_string())?;
    adopt(&app, &state, &path).map(Some)
}

/// Forget the remembered choice and fall back to the automatic locations.
#[tauri::command]
fn reset_data_root(
    app: tauri::AppHandle,
    state: tauri::State<DataRoot>,
) -> Result<DataSource, String> {
    save_stored(&app, None)?;
    let (path, origin, remembered) = resolve_from(&candidates(&app, state.env.as_deref()));
    *state.path.lock().unwrap() = path.clone();
    *state.origin.lock().unwrap() = origin;
    *state.remembered.lock().unwrap() = remembered.clone();
    Ok(describe(&path, origin, remembered))
}

/// Collect the resolution inputs from the real environment.
fn candidates(app: &tauri::AppHandle, env: Option<&Path>) -> Candidates {
    let beside_exe = std::env::current_exe()
        .ok()
        .and_then(|e| e.parent().map(|d| d.join("data")));
    let local_app_data = std::env::var("LOCALAPPDATA")
        .ok()
        .map(|l| Path::new(&l).join("Rpeak").join("data"));
    let repo_debug = if cfg!(debug_assertions) {
        Some(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../data"))
    } else {
        None
    };
    Candidates {
        env: env.map(Path::to_path_buf),
        stored: load_stored(app),
        beside_exe,
        local_app_data,
        repo_debug,
    }
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
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_dataset,
            data_source,
            set_data_root,
            choose_data_root,
            reset_data_root
        ])
        .setup(|app| {
            let env = std::env::var("RPEAK_DATA_DIR").ok().map(PathBuf::from);
            let (path, origin, remembered) =
                resolve_from(&candidates(app.handle(), env.as_deref()));
            eprintln!("rpeak: dataset at {} ({origin:?})", path.display());
            app.manage(DataRoot {
                path: Mutex::new(path.clone()),
                origin: Mutex::new(origin),
                remembered: Mutex::new(remembered),
                env,
            });

            let Some(window) = app.get_webview_window("main") else {
                return Ok(());
            };

            // Surface a missing dataset in the window title rather than only on
            // stderr, which a packaged app has no console to show.
            if !path.is_dir() {
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
