#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    net::TcpListener,
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
use tauri::{Manager, State};
use tauri_plugin_shell::{process::CommandChild, ShellExt};

struct Backend {
    url: Mutex<String>,
    child: Mutex<Option<CommandChild>>,
}

#[tauri::command]
fn backend_url(backend: State<'_, Arc<Backend>>) -> String {
    backend.url.lock().unwrap().clone()
}

fn main() {
    let backend = Arc::new(Backend {
        url: Mutex::new(String::new()),
        child: Mutex::new(None),
    });
    let backend_state = Arc::clone(&backend);

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .manage(Arc::clone(&backend))
        .invoke_handler(tauri::generate_handler![backend_url])
        .setup(move |app| {
            #[cfg(debug_assertions)]
            {
                *backend_state.url.lock().unwrap() = "http://127.0.0.1:5000".to_string();
                return Ok(());
            }

            #[cfg(not(debug_assertions))]
            {
                let listener = TcpListener::bind("127.0.0.1:0")?;
                let port = listener.local_addr()?.port();
                drop(listener);

                let (_events, command) = app
                    .shell()
                    .sidecar("rsvp-backend")?
                    .env("RSVP_HOST", "127.0.0.1")
                    .env("RSVP_PORT", port.to_string())
                    .env(
                        "RSVP_DATA_DIR",
                        app.path().app_data_dir()?.to_string_lossy().to_string(),
                    )
                    .env(
                        "RSVP_APP_ROOT",
                        app.path().resource_dir()?.to_string_lossy().to_string(),
                    )
                    .spawn()?;

                backend_state.child.lock().unwrap().replace(command);

                let mut ready = false;
                for _ in 0..200 {
                    if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
                        ready = true;
                        break;
                    }
                    thread::sleep(Duration::from_millis(100));
                }
                if !ready {
                    return Err(std::io::Error::new(
                        std::io::ErrorKind::TimedOut,
                        "BookTube backend did not start within 20 seconds",
                    )
                    .into());
                }
                *backend_state.url.lock().unwrap() = format!("http://127.0.0.1:{port}");
                Ok(())
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building Tauri application")
        .run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(mut child) = backend.child.lock().unwrap().take() {
                    let _ = child.kill();
                }
            }
        });
}