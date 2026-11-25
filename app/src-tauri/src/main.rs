// Hide the console window on Windows release builds. The `windows_subsystem`
// attribute applies to the whole binary, so it lives in the thin entry point
// rather than in the library that also serves mobile targets.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    rpeak_lib::run()
}
