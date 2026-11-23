#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::sync::Mutex;
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{Emitter, Manager, State};

/// PDFs passed on the command line (double-click in Explorer, "Open with")
struct Pending(Mutex<Vec<String>>);

fn pdf_args(args: &[String]) -> Vec<String> {
    args.iter().filter(|a| a.to_lowercase().ends_with(".pdf")).cloned().collect()
}

#[tauri::command]
fn take_opened(p: State<Pending>) -> Vec<String> {
    std::mem::take(&mut *p.0.lock().unwrap())
}

#[tauri::command]
fn read_file(path: String) -> Result<Response, String> {
    std::fs::read(&path).map(Response::new).map_err(|e| e.to_string())
}

/// raw body = file bytes, header "x-path" = hex of the UTF-8 path
#[tauri::command]
fn write_file(request: Request) -> Result<(), String> {
    let hex = request.headers().get("x-path").ok_or("no path")?.to_str().map_err(|e| e.to_string())?;
    let bytes: Result<Vec<u8>, _> = (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(&hex[i..i + 2], 16)).collect();
    let path = String::from_utf8(bytes.map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    match request.body() {
        InvokeBody::Raw(b) => std::fs::write(&path, b).map_err(|e| e.to_string()),
        _ => Err("bad body".into()),
    }
}

fn main() {
    let first = pdf_args(&std::env::args().collect::<Vec<_>>());
    tauri::Builder::default()
        // a second launch (another PDF double-clicked) hands its files to the running window → new tab
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            let files = pdf_args(&args);
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
                if !files.is_empty() {
                    let _ = w.emit("files-opened", files);
                }
            }
        }))
        .manage(Pending(Mutex::new(first)))
        .invoke_handler(tauri::generate_handler![take_opened, read_file, write_file])
        .run(tauri::generate_context!())
        .expect("error while running Wave PDF");
}
