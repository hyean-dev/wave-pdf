fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(&["take_opened", "read_file", "write_file"])),
    )
    .expect("failed to run tauri-build");
}
