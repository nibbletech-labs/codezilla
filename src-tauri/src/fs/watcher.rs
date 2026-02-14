use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub struct FileWatcher {
    _watcher: RecommendedWatcher,
    _stop_tx: mpsc::Sender<()>,
}

pub type WatcherState = Arc<Mutex<Option<FileWatcher>>>;

impl FileWatcher {
    pub fn start(path: &str, app_handle: AppHandle) -> Result<Self, String> {
        let (event_tx, event_rx) = mpsc::channel::<Event>();
        let (stop_tx, stop_rx) = mpsc::channel::<()>();

        let mut watcher = RecommendedWatcher::new(
            move |result: Result<Event, notify::Error>| {
                if let Ok(event) = result {
                    let _ = event_tx.send(event);
                }
            },
            notify::Config::default().with_poll_interval(Duration::from_millis(300)),
        )
        .map_err(|e| format!("Failed to create watcher: {}", e))?;

        watcher
            .watch(std::path::Path::new(path), RecursiveMode::Recursive)
            .map_err(|e| format!("Failed to watch path: {}", e))?;

        // Debounce thread: collect events for 300ms, then emit unique parent dirs
        std::thread::spawn(move || {
            loop {
                // Wait for first event or stop signal
                let event = match event_rx.recv_timeout(Duration::from_secs(5)) {
                    Ok(ev) => ev,
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        // Check stop signal
                        if stop_rx.try_recv().is_ok() {
                            break;
                        }
                        continue;
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                };

                // Check stop signal
                if stop_rx.try_recv().is_ok() {
                    break;
                }

                // Collect affected parent dirs
                let mut changed_dirs: HashSet<PathBuf> = HashSet::new();
                for path in &event.paths {
                    if let Some(parent) = path.parent() {
                        changed_dirs.insert(parent.to_path_buf());
                    }
                }

                // Drain additional events within the debounce window
                let deadline = std::time::Instant::now() + Duration::from_millis(300);
                loop {
                    let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                    if remaining.is_zero() {
                        break;
                    }
                    match event_rx.recv_timeout(remaining) {
                        Ok(ev) => {
                            for path in &ev.paths {
                                if let Some(parent) = path.parent() {
                                    changed_dirs.insert(parent.to_path_buf());
                                }
                            }
                        }
                        Err(_) => break,
                    }
                }

                // Emit to frontend
                let dirs: Vec<String> = changed_dirs
                    .into_iter()
                    .map(|p| p.to_string_lossy().to_string())
                    .collect();

                let _ = app_handle.emit("fs-change", dirs);
            }
        });

        Ok(FileWatcher {
            _watcher: watcher,
            _stop_tx: stop_tx,
        })
    }
}

#[tauri::command]
pub fn start_watching(
    path: String,
    app_handle: AppHandle,
    state: tauri::State<'_, WatcherState>,
) -> Result<(), String> {
    let canonical = super::canonicalize_path(&path)?;
    let path = canonical.to_string_lossy().to_string();
    let mut guard = state.lock().map_err(|e| format!("Lock error: {}", e))?;

    // Stop existing watcher by dropping it
    *guard = None;

    let watcher = FileWatcher::start(&path, app_handle)?;
    *guard = Some(watcher);
    Ok(())
}

#[tauri::command]
pub fn stop_watching(state: tauri::State<'_, WatcherState>) -> Result<(), String> {
    let mut guard = state.lock().map_err(|e| format!("Lock error: {}", e))?;
    *guard = None;
    Ok(())
}
