#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};
#[cfg(debug_assertions)]
use std::{
    path::PathBuf,
    process::{Child, Command},
};
use tauri::{Manager, State};
use tauri_plugin_shell::process::CommandChild;
#[cfg(not(debug_assertions))]
use tauri_plugin_shell::ShellExt;

struct Backend {
    url: Mutex<String>,
    child: Mutex<Option<BackendChild>>,
}

enum BackendChild {
    #[cfg(debug_assertions)]
    Development(Child),
    Packaged(CommandChild),
}

impl BackendChild {
    fn stop(self) {
        match self {
            #[cfg(debug_assertions)]
            Self::Development(mut child) => {
                let _ = child.kill();
                let _ = child.wait();
            }
            Self::Packaged(child) => {
                let _ = child.kill();
            }
        }
    }
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
            let port_listener = TcpListener::bind("127.0.0.1:0")?;
            let port = port_listener.local_addr()?.port();
            drop(port_listener);

            let data_dir = app.path().app_data_dir()?;
            std::fs::create_dir_all(&data_dir)?;

            #[cfg(debug_assertions)]
            let child = {
                let root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                    .parent()
                    .expect("Tauri manifest has a project root")
                    .to_path_buf();
                let venv_python = if cfg!(windows) {
                    root.join(".venv/Scripts/python.exe")
                } else {
                    root.join(".venv/bin/python")
                };
                let python = if venv_python.is_file() {
                    venv_python.to_string_lossy().into_owned()
                } else if cfg!(windows) {
                    "python".to_string()
                } else {
                    "python3".to_string()
                };
                let child = Command::new(python)
                    .arg("app.py")
                    .current_dir(&root)
                    .env("RSVP_HOST", "127.0.0.1")
                    .env("RSVP_PORT", port.to_string())
                    .env("RSVP_DATA_DIR", &data_dir)
                    .env("RSVP_APP_ROOT", &root)
                    .spawn()?;
                BackendChild::Development(child)
            };

            #[cfg(not(debug_assertions))]
            let child = {
                let resource_dir = app.path().resource_dir()?;
                let (_events, child) = app
                    .shell()
                    .sidecar("rsvp-backend")?
                    .env("RSVP_HOST", "127.0.0.1")
                    .env("RSVP_PORT", port.to_string())
                    .env("RSVP_DATA_DIR", data_dir.to_string_lossy().to_string())
                    .env("RSVP_APP_ROOT", resource_dir.to_string_lossy().to_string())
                    .spawn()?;
                BackendChild::Packaged(child)
            };

            backend_state.child.lock().unwrap().replace(child);

            let mut ready = false;
            for _ in 0..200 {
                if TcpStream::connect(("127.0.0.1", port)).is_ok() {
                    ready = true;
                    break;
                }
                thread::sleep(Duration::from_millis(100));
            }
            if !ready {
                if let Some(child) = backend_state.child.lock().unwrap().take() {
                    child.stop();
                }
                return Err(std::io::Error::new(
                    std::io::ErrorKind::TimedOut,
                    "BookTube backend did not start within 20 seconds",
                )
                .into());
            }

            *backend_state.url.lock().unwrap() = format!("http://127.0.0.1:{port}");
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building Tauri application")
        .run(move |_app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(child) = backend.child.lock().unwrap().take() {
                    child.stop();
                }
            }
        });
}
