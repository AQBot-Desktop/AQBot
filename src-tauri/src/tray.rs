use aqbot_core::types::{AppSettings, TrayIconStyle};
use serde::{Deserialize, Serialize};
use tauri::{
    image::Image,
    menu::{CheckMenuItem, IconMenuItem, Menu, MenuItem, NativeIcon, PredefinedMenuItem},
    tray::TrayIconBuilder,
    AppHandle, Emitter, Manager,
};
use tauri_plugin_opener::OpenerExt;

const TRAY_ID: &str = "aqbot-tray";
const GITHUB_URL: &str = "https://github.com/AQBot-Desktop/AQBot";
const RECENT_CONVERSATION_LIMIT: u64 = 5;
const TITLE_MAX_CHARS: usize = 40;
const COLOR_TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/64x64.png");
const MONOCHROME_TRAY_ICON_BYTES: &[u8] = include_bytes!("../icons/tray-monochrome.png");

#[derive(Clone)]
pub(crate) struct TrayIconAppearance {
    pub(crate) image: Image<'static>,
    pub(crate) is_template: bool,
}

fn resolved_tray_icon_style(requested: TrayIconStyle) -> TrayIconStyle {
    #[cfg(target_os = "macos")]
    {
        requested
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = requested;
        TrayIconStyle::Color
    }
}

pub(crate) fn tray_icon_appearance(
    requested: TrayIconStyle,
) -> Result<TrayIconAppearance, Box<dyn std::error::Error>> {
    let resolved = resolved_tray_icon_style(requested);
    let bytes = match resolved {
        TrayIconStyle::Color => COLOR_TRAY_ICON_BYTES,
        TrayIconStyle::Monochrome => MONOCHROME_TRAY_ICON_BYTES,
    };
    Ok(TrayIconAppearance {
        image: Image::from_bytes(bytes)?,
        is_template: resolved == TrayIconStyle::Monochrome,
    })
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum PendingTrayAction {
    OpenConversation { conversation_id: String },
    CheckUpdate,
}

struct TrayLabels {
    show: &'static str,
    quit: &'static str,
    recent: &'static str,
    untitled: &'static str,
    selection_toolbar: &'static str,
    github: &'static str,
    check_update: &'static str,
}

fn tray_labels(language: &str) -> TrayLabels {
    let lang = language.to_ascii_lowercase();
    if lang == "en" || lang.starts_with("en-") {
        TrayLabels {
            show: "Show",
            quit: "Quit",
            recent: "Recent",
            untitled: "New conversation",
            selection_toolbar: "Selection Toolbar",
            github: "GitHub",
            check_update: "Check for Updates",
        }
    } else if lang == "zh-tw" {
        TrayLabels {
            show: "顯示主視窗",
            quit: "退出 AQBot",
            recent: "最近對話",
            untitled: "新對話",
            selection_toolbar: "劃詞工具列",
            github: "GitHub",
            check_update: "檢查更新",
        }
    } else if lang == "ja" {
        TrayLabels {
            show: "メインウィンドウを表示",
            quit: "AQBot を終了",
            recent: "最近の会話",
            untitled: "新しい会話",
            selection_toolbar: "選択ツールバー",
            github: "GitHub",
            check_update: "更新を確認",
        }
    } else if lang == "ko" {
        TrayLabels {
            show: "메인 창 표시",
            quit: "AQBot 종료",
            recent: "최근 대화",
            untitled: "새 대화",
            selection_toolbar: "선택 도구 모음",
            github: "GitHub",
            check_update: "업데이트 확인",
        }
    } else if lang == "fr" {
        TrayLabels {
            show: "Afficher",
            quit: "Quitter AQBot",
            recent: "Récent",
            untitled: "Nouvelle conversation",
            selection_toolbar: "Barre de sélection",
            github: "GitHub",
            check_update: "Vérifier les mises à jour",
        }
    } else if lang == "de" {
        TrayLabels {
            show: "Anzeigen",
            quit: "AQBot beenden",
            recent: "Zuletzt",
            untitled: "Neue Unterhaltung",
            selection_toolbar: "Auswahl-Toolbar",
            github: "GitHub",
            check_update: "Nach Updates suchen",
        }
    } else if lang == "es" {
        TrayLabels {
            show: "Mostrar",
            quit: "Salir de AQBot",
            recent: "Recientes",
            untitled: "Nueva conversación",
            selection_toolbar: "Barra de selección",
            github: "GitHub",
            check_update: "Buscar actualizaciones",
        }
    } else if lang == "ru" {
        TrayLabels {
            show: "Показать",
            quit: "Выйти из AQBot",
            recent: "Недавние",
            untitled: "Новый диалог",
            selection_toolbar: "Панель выделения",
            github: "GitHub",
            check_update: "Проверить обновления",
        }
    } else if lang == "hi" {
        TrayLabels {
            show: "दिखाएं",
            quit: "AQBot छोड़ें",
            recent: "हालिया",
            untitled: "नई बातचीत",
            selection_toolbar: "चयन टूलबार",
            github: "GitHub",
            check_update: "अपडेट जांचें",
        }
    } else if lang == "ar" {
        TrayLabels {
            show: "عرض",
            quit: "إنهاء AQBot",
            recent: "الأخيرة",
            untitled: "محادثة جديدة",
            selection_toolbar: "شريط التحديد",
            github: "GitHub",
            check_update: "التحقق من التحديثات",
        }
    } else {
        // zh-CN and fallback
        TrayLabels {
            show: "显示主窗口",
            quit: "退出 AQBot",
            recent: "最近对话",
            untitled: "新对话",
            selection_toolbar: "划词工具栏",
            github: "GitHub",
            check_update: "检查更新",
        }
    }
}

fn format_conversation_title(title: &str, fallback: &str) -> String {
    let trimmed = title.trim();
    let base = if trimmed.is_empty() {
        fallback
    } else {
        trimmed
    };
    let count = base.chars().count();
    if count <= TITLE_MAX_CHARS {
        base.to_string()
    } else {
        let truncated: String = base
            .chars()
            .take(TITLE_MAX_CHARS.saturating_sub(1))
            .collect();
        format!("{truncated}…")
    }
}

fn load_app_menu_icon() -> Option<Image<'static>> {
    Image::from_bytes(include_bytes!("../icons/32x32.png")).ok()
}

/// Append a menu item with a native template icon when the platform supports it
/// (macOS). Falls back to a plain item elsewhere so Windows/Linux still work.
fn append_native_icon_item(
    app: &AppHandle,
    menu: &Menu<tauri::Wry>,
    id: &str,
    text: &str,
    enabled: bool,
    icon: NativeIcon,
) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(target_os = "macos")]
    {
        let item = IconMenuItem::with_id_and_native_icon(
            app,
            id,
            text,
            enabled,
            Some(icon),
            None::<&str>,
        )?;
        menu.append(&item)?;
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = icon;
        let item = MenuItem::with_id(app, id, text, enabled, None::<&str>)?;
        menu.append(&item)?;
    }
    Ok(())
}

/// Append an item with a custom image icon when available, else plain text.
fn append_image_icon_item(
    app: &AppHandle,
    menu: &Menu<tauri::Wry>,
    id: &str,
    text: &str,
    enabled: bool,
    icon: Option<Image<'_>>,
) -> Result<(), Box<dyn std::error::Error>> {
    if icon.is_some() {
        let item = IconMenuItem::with_id(app, id, text, enabled, icon, None::<&str>)?;
        menu.append(&item)?;
    } else {
        let item = MenuItem::with_id(app, id, text, enabled, None::<&str>)?;
        menu.append(&item)?;
    }
    Ok(())
}

fn build_menu(
    app: &AppHandle,
    language: &str,
    recent: &[(String, String)],
    selection_toolbar_enabled: bool,
) -> Result<Menu<tauri::Wry>, Box<dyn std::error::Error>> {
    let labels = tray_labels(language);
    let menu = Menu::new(app)?;
    let app_icon = load_app_menu_icon();

    // Show main window — app logo
    append_image_icon_item(app, &menu, "show", labels.show, true, app_icon.clone())?;

    if !recent.is_empty() {
        let sep_recent = PredefinedMenuItem::separator(app)?;
        menu.append(&sep_recent)?;

        // Recent section header — list icon
        append_native_icon_item(
            app,
            &menu,
            "recent_header",
            labels.recent,
            false,
            NativeIcon::ListView,
        )?;

        for (id, title) in recent {
            let text = format_conversation_title(title, labels.untitled);
            // Conversation rows — document-style icon (native template adapts to dark/light)
            append_native_icon_item(
                app,
                &menu,
                &format!("conversation:{}", id),
                &text,
                true,
                NativeIcon::MultipleDocuments,
            )?;
        }
    }

    let sep_actions = PredefinedMenuItem::separator(app)?;
    menu.append(&sep_actions)?;

    // Selection toolbar toggle — CheckMenuItem already shows a checkmark; no extra icon API.
    let selection_toolbar = CheckMenuItem::with_id(
        app,
        "toggle_selection_toolbar",
        labels.selection_toolbar,
        true,
        selection_toolbar_enabled,
        None::<&str>,
    )?;
    menu.append(&selection_toolbar)?;

    // GitHub — system Share template (matches size/color of other native icons)
    append_native_icon_item(
        app,
        &menu,
        "open_github",
        labels.github,
        true,
        NativeIcon::Share,
    )?;

    // Check for updates — refresh
    append_native_icon_item(
        app,
        &menu,
        "check_update",
        labels.check_update,
        true,
        NativeIcon::Refresh,
    )?;

    let sep_quit = PredefinedMenuItem::separator(app)?;
    menu.append(&sep_quit)?;

    // Quit — stop/exit style icon
    append_native_icon_item(
        app,
        &menu,
        "quit",
        labels.quit,
        true,
        NativeIcon::StopProgress,
    )?;

    Ok(menu)
}

fn set_pending_action(app: &AppHandle, action: PendingTrayAction) {
    let state = app.state::<crate::AppState>();
    if let Ok(mut guard) = state.pending_tray_action.lock() {
        *guard = Some(action);
    };
}

pub fn take_pending_action(app: &AppHandle) -> Option<PendingTrayAction> {
    let state = app.state::<crate::AppState>();
    let action = state
        .pending_tray_action
        .lock()
        .ok()
        .and_then(|mut guard| guard.take());
    action
}

fn open_conversation_from_tray(app: &AppHandle, conversation_id: &str) {
    // Queue only when the main webview is gone so restore can deliver the action later.
    if app.get_webview_window("main").is_none() {
        set_pending_action(
            app,
            PendingTrayAction::OpenConversation {
                conversation_id: conversation_id.to_string(),
            },
        );
    }
    crate::window_lifecycle::restore_main_window(app);
    let _ = app.emit("tray-open-conversation", conversation_id);
}

fn request_check_update_from_tray(app: &AppHandle) {
    if app.get_webview_window("main").is_none() {
        set_pending_action(app, PendingTrayAction::CheckUpdate);
    }
    crate::window_lifecycle::restore_main_window(app);
    let _ = app.emit("tray-check-update", ());
}

fn open_github(app: &AppHandle) {
    if let Err(err) = app.opener().open_url(GITHUB_URL, None::<&str>) {
        tracing::warn!("Failed to open GitHub from tray: {}", err);
    }
}

async fn toggle_selection_toolbar(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<crate::AppState>();
    let mut settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;
    settings.selection_toolbar.enabled = !settings.selection_toolbar.enabled;
    settings
        .selection_toolbar
        .validate()
        .map_err(|e| e.to_string())?;
    aqbot_core::repo::settings::save_settings(&state.sea_db, &settings)
        .await
        .map_err(|e| e.to_string())?;
    state.selection_toolbar.reconcile(app, &settings).await;
    let enabled = settings.selection_toolbar.enabled;
    let _ = app.emit("tray-selection-toolbar-changed", enabled);
    sync_tray_menu(app).await.map_err(|e| e.to_string())?;
    Ok(())
}

fn handle_menu_event(app: &AppHandle, id: &str) {
    match id {
        "show" => {
            crate::window_lifecycle::restore_main_window(app);
        }
        "quit" => {
            let state = app.state::<crate::AppState>();
            state
                .is_quitting
                .store(true, std::sync::atomic::Ordering::Relaxed);
            app.exit(0);
        }
        "open_github" => open_github(app),
        "check_update" => request_check_update_from_tray(app),
        "toggle_selection_toolbar" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(err) = toggle_selection_toolbar(&app).await {
                    tracing::warn!("Failed to toggle selection toolbar from tray: {}", err);
                }
            });
        }
        "recent_header" => {}
        other if other.starts_with("conversation:") => {
            let conversation_id = &other["conversation:".len()..];
            if !conversation_id.is_empty() {
                open_conversation_from_tray(app, conversation_id);
            }
        }
        _ => {}
    }
}

pub(crate) fn create_tray(
    app: &AppHandle, settings: &AppSettings, appearance: TrayIconAppearance,
) -> Result<(), Box<dyn std::error::Error>> {
    let menu = build_menu(app, &settings.language, &[], false)?;

    TrayIconBuilder::with_id(TRAY_ID)
        .icon(appearance.image)
        .icon_as_template(appearance.is_template)
        .menu(&menu)
        .show_menu_on_left_click(false)
        .tooltip("AQBot")
        .on_menu_event(|app, event| {
            handle_menu_event(app, event.id.as_ref());
        })
        .on_tray_icon_event(|tray, event| {
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    if w.is_visible().unwrap_or(false) {
                        let _ = crate::window_lifecycle::release_webview_window_to_tray(&w);
                    } else {
                        crate::window_lifecycle::restore_main_window(app);
                    }
                } else {
                    crate::window_lifecycle::restore_main_window(app);
                }
            }
        })
        .build(app)?;

    // Populate recent conversations / toolbar check state after tray exists.
    request_tray_menu_sync(app);

    Ok(())
}

pub(crate) fn apply_tray_appearance(
    app: &AppHandle,
    appearance: &TrayIconAppearance,
) -> Result<(), String> {
    let tray = app.tray_by_id(TRAY_ID)
        .ok_or_else(|| "system tray does not exist".to_string())?;
    tray.set_icon(Some(appearance.image.clone())).map_err(|error| error.to_string())?;
    tray.set_icon_as_template(appearance.is_template).map_err(|error| error.to_string())
}

/// Load settings + recent conversations and rebuild the tray menu.
pub async fn sync_tray_menu(app: &AppHandle) -> Result<(), String> {
    let state = app.state::<crate::AppState>();
    let settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;
    let recent_rows = aqbot_core::repo::conversation::list_recent_conversations(
        &state.sea_db,
        RECENT_CONVERSATION_LIMIT,
    )
    .await
    .unwrap_or_else(|err| {
        tracing::warn!("Failed to load recent conversations for tray: {}", err);
        Vec::new()
    });
    let recent: Vec<(String, String)> = recent_rows.into_iter().map(|c| (c.id, c.title)).collect();
    let language = settings.language.clone();
    let selection_toolbar_enabled = settings.selection_toolbar.enabled;

    let app_handle = app.clone();
    app.run_on_main_thread(move || {
        match build_menu(&app_handle, &language, &recent, selection_toolbar_enabled) {
            Ok(menu) => {
                if let Some(tray) = app_handle.tray_by_id(TRAY_ID) {
                    if let Err(err) = tray.set_menu(Some(menu)) {
                        tracing::warn!("Failed to set tray menu: {}", err);
                    }
                }
            }
            Err(err) => tracing::warn!("Failed to build tray menu: {}", err),
        }
    })
    .map_err(|e| e.to_string())?;

    Ok(())
}

/// Fire-and-forget tray rebuild (safe from sync contexts like save_settings).
pub fn request_tray_menu_sync(app: &AppHandle) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        if let Err(err) = sync_tray_menu(&app).await {
            tracing::warn!("Failed to sync tray menu: {}", err);
        }
    });
}

/// Backward-compatible entry used by settings save.
pub fn sync_tray_language(
    app: &AppHandle,
    _language: &str,
) -> Result<(), Box<dyn std::error::Error>> {
    request_tray_menu_sync(app);
    Ok(())
}

pub fn destroy_tray(app: &AppHandle) {
    let _ = app.remove_tray_by_id(TRAY_ID);
}

pub fn tray_exists(app: &AppHandle) -> bool {
    app.tray_by_id(TRAY_ID).is_some()
}

#[cfg(test)]
mod tests {
    use super::{
        format_conversation_title, resolved_tray_icon_style, tray_icon_appearance, tray_labels,
        MONOCHROME_TRAY_ICON_BYTES, TITLE_MAX_CHARS,
    };
    use aqbot_core::types::TrayIconStyle;
    use tauri::image::Image;

    #[test]
    fn truncates_long_titles() {
        let long = "a".repeat(TITLE_MAX_CHARS + 10);
        let formatted = format_conversation_title(&long, "新对话");
        assert_eq!(formatted.chars().count(), TITLE_MAX_CHARS);
        assert!(formatted.ends_with('…'), "got: {formatted}");
    }

    #[test]
    fn empty_title_uses_fallback() {
        assert_eq!(format_conversation_title("   ", "新对话"), "新对话");
    }

    #[test]
    fn zh_cn_labels_for_default() {
        let labels = tray_labels("zh-CN");
        assert_eq!(labels.show, "显示主窗口");
        assert_eq!(labels.selection_toolbar, "划词工具栏");
        assert_eq!(labels.check_update, "检查更新");
    }

    #[test]
    fn en_labels() {
        let labels = tray_labels("en-US");
        assert_eq!(labels.show, "Show");
        assert_eq!(labels.recent, "Recent");
        assert_eq!(labels.check_update, "Check for Updates");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_preserves_requested_tray_icon_style() {
        assert_eq!(
            resolved_tray_icon_style(TrayIconStyle::Monochrome),
            TrayIconStyle::Monochrome
        );
        assert_eq!(
            resolved_tray_icon_style(TrayIconStyle::Color),
            TrayIconStyle::Color
        );
        assert!(
            tray_icon_appearance(TrayIconStyle::Monochrome)
                .expect("monochrome tray icon should load")
                .is_template
        );
        assert!(
            !tray_icon_appearance(TrayIconStyle::Color)
                .expect("color tray icon should load")
                .is_template
        );
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn non_macos_always_uses_color_tray_icon() {
        assert_eq!(
            resolved_tray_icon_style(TrayIconStyle::Monochrome),
            TrayIconStyle::Color
        );
        assert!(
            !tray_icon_appearance(TrayIconStyle::Monochrome)
                .expect("color tray icon should load")
                .is_template
        );
    }

    #[test]
    fn monochrome_asset_is_a_single_color_alpha_mask() {
        let image = Image::from_bytes(MONOCHROME_TRAY_ICON_BYTES)
            .expect("monochrome tray icon should decode");
        assert_eq!((image.width(), image.height()), (36, 36));

        let pixels: Vec<&[u8]> = image.rgba().chunks_exact(4).collect();
        assert!(pixels.iter().any(|pixel| pixel[3] == 0));
        assert!(pixels.iter().any(|pixel| pixel[3] == 255));
        assert!(pixels.iter().any(|pixel| (1..=254).contains(&pixel[3])));
        assert!(pixels
            .iter()
            .all(|pixel| pixel[0] == 0 && pixel[1] == 0 && pixel[2] == 0));
    }
}
