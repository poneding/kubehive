fn main() {
    println!("cargo:rerun-if-changed=icons/icon.icns");
    tauri_build::build()
}
