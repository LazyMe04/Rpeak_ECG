fn main() {
    tauri_build::build();

    // `tauri-build` links the compiled application manifest (Common-Controls v6,
    // icon, version info) into binaries. The unit-test executable is not a
    // binary in that sense, so this crate declares `test = false` on `[lib]` and
    // keeps its tests in `tests/`, which *is* a link target for the instruction
    // below.
    //
    // Without the manifest Windows binds `comctl32.dll` to v5, which does not
    // export `TaskDialogIndirect` — a static import of `tauri-runtime-wry` — and
    // the harness dies with `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND` before it
    // lists a single test. The failure names no missing symbol: it just never
    // starts.
    //
    // `rustc-link-arg` (all targets) would also work, but it links the archive
    // into the app binary a second time, and `ld` then reports `.rsrc merge
    // failure: duplicate leaf` for every icon, on every build.
    #[cfg(windows)]
    {
        if let Ok(out) = std::env::var("OUT_DIR") {
            let resource = std::path::Path::new(&out).join("libresource.a");
            if resource.exists() {
                println!("cargo:rustc-link-arg-tests={}", resource.display());
            }
        }
    }
}
