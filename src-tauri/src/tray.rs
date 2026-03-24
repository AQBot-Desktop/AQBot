use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

const TRAY_ID: &str = "aqbot-tray";

fn tray_labels(language: &str) -> (&'static str, &'static str) {
    let language = language.to_ascii_lowercase();
    if language == "en" || language.starts_with("en-") {
        ("Show", "Quit")
    } else {
        ("显示主窗口", "退出 AQBot")
    }
}

fn build_menu(
    app: &AppHandle,
    language: &str,
) -> Result<Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let (show_label, quit_label) = tray_labels(language);
    let show = MenuItem::with_id(app, "show", show_label, true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", quit_label, true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &quit])?;
    Ok(menu)
}

pub fn create_tray(app: &AppHandle, language: &str) -> Result<(), Box<dyn std::error::Error>> {
    let menu = build_menu(app, language)?;
    let icon = Image::from_path("icons/icon.png").unwrap_or_else(|_| {
        Image::from_bytes(include_bytes!("../icons/32x32.png"))
            .expect("failed to load fallback tray icon")
    });

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon)
        .menu(&menu)
        .tooltip("AQBot")
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click { .. } = event {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    if w.is_visible().unwrap_or(false) {
                        let _ = w.hide();
                    } else {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            }
        })
        .build(app)?;

    Ok(())
}

pub fn sync_tray_language(
    app: &AppHandle,
    language: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    let menu = build_menu(app, language)?;
    if let Some(tray) = app.tray_by_id(TRAY_ID) {
        tray.set_menu(Some(menu))?;
    } else {
        create_tray(app, language)?;
    }
    Ok(())
}
