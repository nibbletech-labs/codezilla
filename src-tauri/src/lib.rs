mod config;
mod fs;
mod git;
mod pty;
mod transcript;

use pty::PtyManager;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use tauri::ipc::Channel;
use tauri::menu::{CheckMenuItem, IconMenuItem};
use tauri::{Manager, State};
use tokio::sync::Mutex;

/// Generate RGBA pixel data for a rounded square color swatch.
/// If `tick_hex` is Some, overlay a checkmark in that color.
fn color_swatch(hex: &str, size: u32, radius: u32, tick_hex: Option<&str>) -> Vec<u8> {
    let r = u8::from_str_radix(&hex[1..3], 16).unwrap_or(0);
    let g = u8::from_str_radix(&hex[3..5], 16).unwrap_or(0);
    let b = u8::from_str_radix(&hex[5..7], 16).unwrap_or(0);
    let mut rgba = vec![0u8; (size * size * 4) as usize];
    let rad = radius as f32;
    let s = size as f32;
    for py in 0..size {
        for px in 0..size {
            let cx = px as f32 + 0.5;
            let cy = py as f32 + 0.5;
            let inside = if cx < rad && cy < rad {
                (cx - rad) * (cx - rad) + (cy - rad) * (cy - rad) <= rad * rad
            } else if cx > s - rad && cy < rad {
                (cx - (s - rad)) * (cx - (s - rad)) + (cy - rad) * (cy - rad) <= rad * rad
            } else if cx < rad && cy > s - rad {
                (cx - rad) * (cx - rad) + (cy - (s - rad)) * (cy - (s - rad)) <= rad * rad
            } else if cx > s - rad && cy > s - rad {
                (cx - (s - rad)) * (cx - (s - rad)) + (cy - (s - rad)) * (cy - (s - rad))
                    <= rad * rad
            } else {
                true
            };
            if inside {
                let i = ((py * size + px) * 4) as usize;
                rgba[i] = r;
                rgba[i + 1] = g;
                rgba[i + 2] = b;
                rgba[i + 3] = 255;
            }
        }
    }
    // Overlay a 2px-wide checkmark if requested
    if let Some(th) = tick_hex {
        let tr = u8::from_str_radix(&th[1..3], 16).unwrap_or(0);
        let tg = u8::from_str_radix(&th[3..5], 16).unwrap_or(0);
        let tb = u8::from_str_radix(&th[5..7], 16).unwrap_or(0);
        // Checkmark: short stroke down-right then long stroke up-right, 2px wide
        const TICK: &[(u32, u32)] = &[
            (4, 8),  (5, 8),
            (5, 9),  (6, 9),
            (6, 10), (7, 10),
            (7, 9),  (8, 9),
            (8, 8),  (9, 8),
            (9, 7),  (10, 7),
            (10, 6), (11, 6),
            (11, 5), (12, 5),
        ];
        for &(px, py) in TICK {
            if px < size && py < size {
                let i = ((py * size + px) * 4) as usize;
                rgba[i] = tr;
                rgba[i + 1] = tg;
                rgba[i + 2] = tb;
                rgba[i + 3] = 255;
            }
        }
    }
    rgba
}

type PtyState = Arc<Mutex<PtyManager>>;
type PtySessionCount = Arc<AtomicUsize>;

fn validate_session_id(id: &str) -> Result<(), String> {
    // UUID v4 format: 8-4-4-4-12 hex chars
    let parts: Vec<&str> = id.split('-').collect();
    let valid = parts.len() == 5
        && parts[0].len() == 8
        && parts[1].len() == 4
        && parts[2].len() == 4
        && parts[3].len() == 4
        && parts[4].len() == 12
        && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    if !valid {
        return Err(format!("Invalid session ID: {}", id));
    }
    Ok(())
}

#[tauri::command]
async fn spawn_pty(
    state: State<'_, PtyState>,
    session_count: State<'_, PtySessionCount>,
    session_id: String,
    rows: u16,
    cols: u16,
    channel: Channel<pty::PtyEvent>,
    cwd: Option<String>,
    command: Option<String>,
    activity_mode: Option<String>,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let mut manager = state.lock().await;
    manager.reap_dead();
    manager
        .spawn(session_id, rows, cols, channel, cwd, command, activity_mode)
        .map_err(|e| e.to_string())?;
    session_count.fetch_add(1, Ordering::Relaxed);
    Ok(())
}

#[tauri::command]
async fn write_pty(
    state: State<'_, PtyState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let manager = state.lock().await;
    manager.write(&session_id, &data).map_err(|e| e.to_string())
}

#[tauri::command]
async fn resize_pty(
    state: State<'_, PtyState>,
    session_id: String,
    rows: u16,
    cols: u16,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let manager = state.lock().await;
    manager
        .resize(&session_id, rows, cols)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn kill_pty(
    state: State<'_, PtyState>,
    session_count: State<'_, PtySessionCount>,
    session_id: String,
) -> Result<(), String> {
    validate_session_id(&session_id)?;
    let mut manager = state.lock().await;
    manager.kill(&session_id).map_err(|e| e.to_string())?;
    // Saturating subtract: counter may already be 0 if session exited naturally
    let prev = session_count.load(Ordering::Relaxed);
    if prev > 0 {
        session_count.fetch_sub(1, Ordering::Relaxed);
    }
    Ok(())
}

/// Check if there are running PTY sessions and confirm quit if so.
/// Returns true if the app should proceed with quitting.
fn confirm_quit_if_needed(session_count: &PtySessionCount, handle: &tauri::AppHandle) -> bool {
    if session_count.load(Ordering::Relaxed) == 0 {
        return true;
    }

    use tauri_plugin_dialog::DialogExt;
    handle
        .dialog()
        .message("You have running processes. Quit anyway?")
        .title("Quit Codezilla")
        .kind(tauri_plugin_dialog::MessageDialogKind::Warning)
        .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel)
        .blocking_show()
}

struct MenuState {
    remember_window: std::sync::Mutex<Option<CheckMenuItem<tauri::Wry>>>,
    appearance_items: std::sync::Mutex<Vec<(String, CheckMenuItem<tauri::Wry>)>>,
    accent_items: std::sync::Mutex<Vec<(String, String, String, IconMenuItem<tauri::Wry>)>>,
}

#[tauri::command]
fn sync_remember_window_position(
    state: State<'_, MenuState>,
    checked: bool,
) -> Result<(), String> {
    if let Ok(guard) = state.remember_window.lock() {
        if let Some(item) = guard.as_ref() {
            item.set_checked(checked).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn sync_appearance_menu(
    state: State<'_, MenuState>,
    mode: String,
) -> Result<(), String> {
    if let Ok(items) = state.appearance_items.lock() {
        for (id, item) in items.iter() {
            let is_active = *id == mode;
            item.set_checked(is_active).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[tauri::command]
fn sync_accent_menu(
    state: State<'_, MenuState>,
    color_id: String,
) -> Result<(), String> {
    if let Ok(items) = state.accent_items.lock() {
        for (id, hex, tick_color, item) in items.iter() {
            let tick = if *id == color_id { Some(tick_color.as_str()) } else { None };
            let swatch = color_swatch(hex, 16, 3, tick);
            let img = tauri::image::Image::new_owned(swatch, 16, 16);
            item.set_icon(Some(img)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let pty_state: PtyState = Arc::new(Mutex::new(PtyManager::new()));
    let pty_session_count: PtySessionCount = Arc::new(AtomicUsize::new(0));
    let session_count_for_menu = pty_session_count.clone();
    let session_count_for_window = pty_session_count.clone();
    let watcher_state: fs::watcher::WatcherState = Arc::new(std::sync::Mutex::new(None));
    let transcript_state: transcript::TranscriptState =
        Arc::new(std::sync::Mutex::new(transcript::TranscriptManager::new()));

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .manage(pty_state.clone())
        .manage(pty_session_count)
        .manage(watcher_state)
        .manage(transcript_state)
        .manage(MenuState {
            remember_window: std::sync::Mutex::new(None),
            appearance_items: std::sync::Mutex::new(Vec::new()),
            accent_items: std::sync::Mutex::new(Vec::new()),
        })
        .setup(move |app| {
            #[cfg(target_os = "macos")]
            {
                use tauri::menu::{CheckMenuItem, Menu, MenuItemBuilder, PredefinedMenuItem, Submenu};
                use tauri::{Emitter, Manager};

                if let Some(main_webview) = app.get_webview_window("main") {
                    main_webview
                        .with_webview(|webview| {
                            use objc2_app_kit::{NSWindow, NSWindowCollectionBehavior};
                            unsafe {
                                let ns_window: &NSWindow = &*webview.ns_window().cast();
                                let mut behavior = ns_window.collectionBehavior();
                                behavior |= NSWindowCollectionBehavior::FullScreenPrimary;
                                ns_window.setCollectionBehavior(behavior);
                            }
                        })
                        .ok();
                }

                // Custom Cmd+Q: routes through confirmation instead of quitting directly
                let quit = MenuItemBuilder::with_id("quit", "Quit Codezilla")
                    .accelerator("CmdOrCtrl+Q")
                    .build(app)?;

                let new_claude = MenuItemBuilder::with_id("new-thread-claude", "New Claude Thread")
                    .accelerator("CmdOrCtrl+Alt+C")
                    .build(app)?;
                let new_codex = MenuItemBuilder::with_id("new-thread-codex", "New Codex Thread")
                    .accelerator("CmdOrCtrl+Alt+X")
                    .build(app)?;
                let new_shell = MenuItemBuilder::with_id("new-thread-shell", "New Terminal Thread")
                    .accelerator("CmdOrCtrl+Alt+T")
                    .build(app)?;
                let remove_thread = MenuItemBuilder::with_id("remove-thread", "Remove Thread")
                    .accelerator("CmdOrCtrl+Alt+Delete")
                    .build(app)?;

                let app_submenu = Submenu::with_items(
                    app,
                    "Codezilla",
                    true,
                    &[
                        &PredefinedMenuItem::separator(app)?,
                        &new_claude,
                        &new_codex,
                        &new_shell,
                        &PredefinedMenuItem::separator(app)?,
                        &remove_thread,
                        &PredefinedMenuItem::separator(app)?,
                        &quit,
                    ],
                )?;

                let edit_submenu = Submenu::with_items(
                    app,
                    "Edit",
                    true,
                    &[
                        &PredefinedMenuItem::undo(app, None)?,
                        &PredefinedMenuItem::redo(app, None)?,
                        &PredefinedMenuItem::separator(app)?,
                        &PredefinedMenuItem::cut(app, None)?,
                        &PredefinedMenuItem::copy(app, None)?,
                        &PredefinedMenuItem::paste(app, None)?,
                        &PredefinedMenuItem::select_all(app, None)?,
                    ],
                )?;

                let zoom_in = MenuItemBuilder::with_id("zoom-in", "Increase Text Size")
                    .accelerator("CmdOrCtrl+=")
                    .build(app)?;
                let zoom_out = MenuItemBuilder::with_id("zoom-out", "Decrease Text Size")
                    .accelerator("CmdOrCtrl+-")
                    .build(app)?;
                let zoom_reset = MenuItemBuilder::with_id("zoom-reset", "Reset Text Size")
                    .accelerator("CmdOrCtrl+0")
                    .build(app)?;

                // Appearance items — CheckMenuItems so the active one gets a tick
                let app_dark = CheckMenuItem::with_id(app, "appearance-dark", "Dark", true, true, None::<&str>)?;
                let app_light = CheckMenuItem::with_id(app, "appearance-light", "Light", true, false, None::<&str>)?;
                let app_system = CheckMenuItem::with_id(app, "appearance-system", "System", true, false, None::<&str>)?;

                let appearance_submenu = Submenu::with_items(
                    app,
                    "Appearance",
                    true,
                    &[&app_dark, &app_light, &app_system],
                )?;

                // Accent color items — IconMenuItems with generated colour square images
                // (menu_id, label, hex, textOnAccent, is_default)
                let accent_defs: &[(&str, &str, &str, &str, bool)] = &[
                    ("accent-green",  "Green",  "#C1FF72", "#1e1e1e", true),
                    ("accent-blue",   "Blue",   "#007acc", "#ffffff", false),
                    ("accent-purple", "Purple", "#8b5cf6", "#ffffff", false),
                    ("accent-orange", "Orange", "#e97319", "#ffffff", false),
                    ("accent-rose",   "Rose",   "#e5446d", "#ffffff", false),
                    ("accent-teal",   "Teal",   "#14b8a6", "#ffffff", false),
                    ("accent-amber",  "Amber",  "#f59e0b", "#ffffff", false),
                ];
                let mut accent_menu_items: Vec<(&str, &str, &str, IconMenuItem<tauri::Wry>)> = Vec::new();
                for &(menu_id, label, hex, tick_color, is_default) in accent_defs {
                    let tick = if is_default { Some(tick_color) } else { None };
                    let swatch = color_swatch(hex, 16, 3, tick);
                    let img = tauri::image::Image::new_owned(swatch, 16, 16);
                    let item = IconMenuItem::with_id(app, menu_id, label, true, Some(img), None::<&str>)?;
                    accent_menu_items.push((menu_id, hex, tick_color, item));
                }

                let accent_refs: Vec<&dyn tauri::menu::IsMenuItem<tauri::Wry>> = accent_menu_items
                    .iter()
                    .map(|(_, _, _, item)| item as &dyn tauri::menu::IsMenuItem<tauri::Wry>)
                    .collect();
                let accent_submenu = Submenu::with_items(
                    app,
                    "Accent Color",
                    true,
                    &accent_refs,
                )?;

                let toggle_left = MenuItemBuilder::with_id("toggle-left-panel", "Toggle Sidebar")
                    .accelerator("CmdOrCtrl+[")
                    .build(app)?;
                let toggle_right = MenuItemBuilder::with_id("toggle-right-panel", "Toggle File Panel")
                    .accelerator("CmdOrCtrl+]")
                    .build(app)?;

                let view_submenu = Submenu::with_items(
                    app,
                    "View",
                    true,
                    &[
                        &toggle_left,
                        &toggle_right,
                        &PredefinedMenuItem::separator(app)?,
                        &zoom_in,
                        &zoom_out,
                        &zoom_reset,
                        &PredefinedMenuItem::separator(app)?,
                        &appearance_submenu,
                        &accent_submenu,
                    ],
                )?;

                let remember_window_item = CheckMenuItem::with_id(
                    app,
                    "remember-window-position",
                    "Remember Window Position",
                    true,
                    true,
                    None::<&str>,
                )?;

                let window_submenu = Submenu::with_items(
                    app,
                    "Window",
                    true,
                    &[
                        &PredefinedMenuItem::minimize(app, None)?,
                        &remember_window_item,
                    ],
                )?;

                // Store all menu item handles in MenuState for frontend sync
                if let Some(menu_state) = app.try_state::<MenuState>() {
                    if let Ok(mut guard) = menu_state.remember_window.lock() {
                        *guard = Some(remember_window_item);
                    }
                    if let Ok(mut guard) = menu_state.appearance_items.lock() {
                        *guard = vec![
                            ("dark".into(), app_dark),
                            ("light".into(), app_light),
                            ("system".into(), app_system),
                        ];
                    }
                    if let Ok(mut guard) = menu_state.accent_items.lock() {
                        *guard = accent_menu_items
                            .into_iter()
                            .map(|(id, hex, tick_color, item)| {
                                let short_id = id.strip_prefix("accent-").unwrap_or(id);
                                (short_id.to_string(), hex.to_string(), tick_color.to_string(), item)
                            })
                            .collect();
                    }
                }

                let menu = Menu::with_items(app, &[&app_submenu, &edit_submenu, &view_submenu, &window_submenu])?;
                app.set_menu(menu)?;

                app.on_menu_event(move |app, event| {
                    let id = event.id().0.clone();
                    if id == "quit" {
                        if confirm_quit_if_needed(&session_count_for_menu, app) {
                            // Save window state before destroy (destroy bypasses CloseRequested)
                            use tauri_plugin_window_state::AppHandleExt;
                            let _ = app.save_window_state(tauri_plugin_window_state::StateFlags::all());
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.destroy();
                            }
                        }
                    } else {
                        let _ = app.emit("menu-event", id);
                    }
                });
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            spawn_pty,
            write_pty,
            resize_pty,
            kill_pty,
            fs::read_directory,
            fs::scan_all_files,
            fs::read_file,
            fs::read_file_base64,
            fs::preview_file,
            fs::reveal_in_finder,
            fs::path_exists,
            fs::watcher::start_watching,
            fs::watcher::stop_watching,
            git::get_git_branch,
            git::get_git_status,
            git::get_git_diff_stat,
            git::get_git_diff,
            git::get_file_diff_stat,
            git::get_commit_info,
            git::get_commit_diff,
            transcript::watch_transcript,
            transcript::unwatch_transcript,
            transcript::switch_transcript,
            transcript::register_codex_thread,
            transcript::unregister_codex_thread,
            transcript::get_codex_binding,
            transcript::discover::discover_transcript,
            sync_remember_window_position,
            sync_appearance_menu,
            sync_accent_menu
        ])
        .on_window_event(move |window, event| {
            match event {
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    // Always prevent the default close so we can handle it like Cmd+Q
                    api.prevent_close();
                    if confirm_quit_if_needed(&session_count_for_window, window.app_handle()) {
                        use tauri_plugin_window_state::AppHandleExt;
                        let _ = window.app_handle().save_window_state(tauri_plugin_window_state::StateFlags::all());
                        let _ = window.destroy();
                    }
                }
                tauri::WindowEvent::Destroyed => {
                    let state = pty_state.clone();
                    tauri::async_runtime::spawn(async move {
                        let mut manager = state.lock().await;
                        manager.kill_all();
                    });
                }
                _ => {}
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
