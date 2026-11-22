// Keep Soluna as a GUI application in both debug and release on Windows.
#![cfg_attr(windows, windows_subsystem = "windows")]

fn main() {
    soluna_lib::run()
}
