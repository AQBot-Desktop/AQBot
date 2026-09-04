use std::collections::BTreeMap;

use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tauri_plugin_clipboard_manager::ClipboardExt;

#[cfg(not(target_os = "macos"))]
use crate::selection_toolbar::resolve_app_icons;
#[cfg(target_os = "macos")]
use crate::selection_toolbar::{encode_app_icon_sources, resolve_app_icon_sources};
use crate::{
    selection_toolbar::{
        resolve_app_paths, InstalledApp, OverflowDirection, PermissionSettingsOutcome,
        RuntimeSnapshot, RuntimeStatus, SurfaceSize, ToolRunEvent, SELECTION_TOOLBAR_WINDOW_LABEL,
    },
    AppState,
};

/// Run AppKit icon APIs on the main thread (required on macOS).
#[cfg(target_os = "macos")]
fn run_on_main_thread<T, F>(app: &AppHandle, work: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(work());
    })
    .map_err(|error| error.to_string())?;
    rx.recv()
        .map_err(|_| "Main-thread app resolution channel closed".into())
}

#[tauri::command]
pub async fn selection_toolbar_resolve_app_paths(
    paths: Vec<String>,
) -> Result<Vec<InstalledApp>, String> {
    tauri::async_runtime::spawn_blocking(move || resolve_app_paths(&paths))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn selection_toolbar_resolve_app_icons(
    app: AppHandle,
    ids: Vec<String>,
) -> Result<BTreeMap<String, String>, String> {
    #[cfg(target_os = "macos")]
    {
        // AppKit renders each icon directly to a compact 64px PNG on the main
        // thread; base64 encoding stays on a blocking worker.
        let sources = run_on_main_thread(&app, move || resolve_app_icon_sources(&ids))?;
        return tauri::async_runtime::spawn_blocking(move || encode_app_icon_sources(sources))
            .await
            .map_err(|error| error.to_string());
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        tauri::async_runtime::spawn_blocking(move || resolve_app_icons(&ids))
            .await
            .map_err(|error| error.to_string())?
    }
}

#[tauri::command]
pub async fn selection_toolbar_get_runtime_status(
    state: State<'_, AppState>,
) -> Result<RuntimeStatus, String> {
    Ok(state.selection_toolbar.status().await)
}

#[tauri::command]
pub async fn selection_toolbar_get_snapshot(
    state: State<'_, AppState>,
) -> Result<RuntimeSnapshot, String> {
    Ok(state.selection_toolbar.snapshot().await)
}

fn require_toolbar_window(window: &WebviewWindow) -> Result<(), String> {
    if window.label() != SELECTION_TOOLBAR_WINDOW_LABEL {
        return Err("Selection toolbar input is only available to its own window".into());
    }
    Ok(())
}

#[tauri::command]
pub async fn selection_toolbar_get_input(
    window: WebviewWindow,
    state: State<'_, AppState>,
    selection_id: String,
) -> Result<crate::selection_toolbar::ToolbarInputView, String> {
    require_toolbar_window(&window)?;
    state.selection_toolbar.input_view(&selection_id).await
}

#[tauri::command]
pub async fn selection_toolbar_read_image(
    window: WebviewWindow,
    state: State<'_, AppState>,
    selection_id: String,
) -> Result<tauri::ipc::Response, String> {
    require_toolbar_window(&window)?;
    match state.selection_toolbar.input(&selection_id).await? {
        crate::selection_toolbar::ToolbarInput::Screenshot { png, .. } => {
            Ok(tauri::ipc::Response::new(png.to_vec()))
        }
        crate::selection_toolbar::ToolbarInput::Text(_) => {
            Err("The current input is not an image".into())
        }
    }
}

#[tauri::command]
pub async fn selection_toolbar_clear_capture_error(
    window: WebviewWindow,
    state: State<'_, AppState>,
) -> Result<(), String> {
    require_toolbar_window(&window)?;
    state.selection_toolbar.clear_capture_error().await;
    Ok(())
}

/// Registration shares the frontend's one registration pass, but the callback
/// must outlive the main WebView when it is released to the tray.
#[tauri::command]
pub async fn selection_toolbar_register_screenshot_shortcut(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
    shortcut: String,
) -> Result<(), String> {
    use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};
    if window.label() != "main" {
        return Err("Only the main window can register shortcuts".into());
    }
    let settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .map_err(|error| error.to_string())?;
    if !settings.global_shortcuts_enabled
        || !settings.selection_toolbar.enabled
        || settings
            .selection_toolbar
            .screenshot_shortcut
            .trim()
            .is_empty()
    {
        return Err("Screenshot shortcut is disabled".into());
    }
    app.global_shortcut()
        .on_shortcut(shortcut.as_str(), |app, _, event| {
            if event.state != ShortcutState::Pressed {
                return;
            }
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = app.state::<AppState>();
                if let Err(error) = state.selection_toolbar.capture_screenshot(&app).await {
                    tracing::error!(%error, "Screenshot shortcut failed");
                }
            });
        })
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn selection_toolbar_capture_screenshot(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    if !matches!(window.label(), "main" | "selection-toolbar") {
        return Err("Screenshot capture is unavailable to this window".into());
    }
    state.selection_toolbar.capture_screenshot(&app).await
}

#[tauri::command]
pub async fn selection_toolbar_open_permission_settings(
    state: State<'_, AppState>,
) -> Result<PermissionSettingsOutcome, String> {
    state.selection_toolbar.open_permission_settings()
}

#[tauri::command]
pub async fn selection_toolbar_request_permission(
    state: State<'_, AppState>,
) -> Result<crate::selection_toolbar::PermissionState, String> {
    state.selection_toolbar.request_permission()
}

#[tauri::command]
pub async fn selection_toolbar_retry_monitoring(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<RuntimeStatus, String> {
    state.selection_toolbar.retry(&app).await
}

#[tauri::command]
pub async fn selection_toolbar_trigger(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.selection_toolbar.trigger_shortcut(&app).await
}

#[tauri::command]
pub async fn selection_toolbar_set_surface(
    app: AppHandle,
    state: State<'_, AppState>,
    surface: SurfaceSize,
    overflow_height: Option<f64>,
) -> Result<Option<OverflowDirection>, String> {
    state
        .selection_toolbar
        .set_surface(&app, surface, overflow_height)
        .await
}

#[tauri::command]
pub async fn selection_toolbar_prepare_overflow(
    app: AppHandle,
    state: State<'_, AppState>,
    overflow_height: f64,
) -> Result<OverflowDirection, String> {
    state
        .selection_toolbar
        .prepare_overflow(&app, overflow_height)
        .await
}

#[tauri::command]
pub async fn selection_toolbar_frontend_ready(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.selection_toolbar.mark_frontend_ready(&app).await;
    Ok(())
}

#[tauri::command]
pub async fn selection_toolbar_execute_tool(
    app: AppHandle,
    state: State<'_, AppState>,
    selection_id: String,
    tool_id: String,
    options: Option<crate::selection_toolbar::ToolRunOptions>,
) -> Result<String, String> {
    state.selection_toolbar.lock_interaction();
    let result = crate::selection_toolbar::execute_ai_tool(
        &app,
        state.inner(),
        &selection_id,
        &tool_id,
        options.unwrap_or_default(),
    )
    .await;
    if result.is_err() {
        state.selection_toolbar.unlock_interaction();
    }
    result
}

#[tauri::command]
pub async fn selection_toolbar_follow_up(
    app: AppHandle,
    state: State<'_, AppState>,
    selection_id: String,
    text: String,
) -> Result<String, String> {
    state.selection_toolbar.lock_interaction();
    let result =
        crate::selection_toolbar::follow_up_ai_tool(&app, state.inner(), &selection_id, &text)
            .await;
    if result.is_err() {
        state.selection_toolbar.unlock_interaction();
    }
    result
}

#[tauri::command]
pub async fn selection_toolbar_regenerate(
    app: AppHandle,
    state: State<'_, AppState>,
    selection_id: String,
    request_id: String,
) -> Result<String, String> {
    state.selection_toolbar.lock_interaction();
    let result = crate::selection_toolbar::regenerate_ai_tool(
        &app,
        state.inner(),
        &selection_id,
        &request_id,
    )
    .await;
    if result.is_err() {
        state.selection_toolbar.unlock_interaction();
    }
    result
}

#[tauri::command]
pub async fn selection_toolbar_set_pinned(
    state: State<'_, AppState>,
    selection_id: String,
    pinned: bool,
) -> Result<bool, String> {
    state
        .selection_toolbar
        .set_pinned(&selection_id, pinned)
        .await
}

#[tauri::command]
pub async fn selection_toolbar_drag_ended(
    app: AppHandle,
    state: State<'_, AppState>,
    selection_id: String,
) -> Result<(), String> {
    state
        .selection_toolbar
        .drag_ended(&app, &selection_id)
        .await
}

/// Persist the translate panel's target language (`None` follows the app
/// language again). Saved through the full settings pipeline so validation
/// and toolbar reconciliation behave exactly like the settings page.
#[tauri::command]
pub async fn selection_toolbar_set_translate_target(
    state: State<'_, AppState>,
    language: Option<String>,
) -> Result<(), String> {
    let mut settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .map_err(|error| error.to_string())?;
    settings.selection_toolbar.translate_target_language =
        language.filter(|value| !value.trim().is_empty());
    settings.selection_toolbar.validate()?;
    aqbot_core::repo::settings::save_settings(&state.sea_db, &settings)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn selection_toolbar_stop_generation(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
) -> Result<(), String> {
    if !state.selection_toolbar.stop_run(&request_id).await {
        return Err("The selection toolbar request is no longer active".into());
    }
    state.selection_toolbar.unlock_interaction();
    let snapshot = state.selection_toolbar.snapshot().await;
    let run = snapshot
        .run
        .ok_or_else(|| "The selection toolbar request is no longer active".to_string())?;
    let _ = app.emit_to(
        SELECTION_TOOLBAR_WINDOW_LABEL,
        "selection-toolbar://run",
        ToolRunEvent::Stopped {
            request_id,
            selection_id: run.selection_id,
            // The executor task follows up with the think-tag-finalized output.
            output: None,
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn selection_toolbar_copy_selection(
    app: AppHandle,
    state: State<'_, AppState>,
    selection_id: String,
) -> Result<(), String> {
    state.selection_toolbar.lock_interaction();
    let text = match state.selection_toolbar.selection_text(&selection_id).await {
        Some(text) => text,
        None => {
            state.selection_toolbar.unlock_interaction();
            return Err("The selected text is no longer active".to_string());
        }
    };
    app.clipboard().write_text(text).map_err(|error| {
        state.selection_toolbar.unlock_interaction();
        error.to_string()
    })
}

/// Open the configured search URL in the system default browser with the
/// selected text percent-encoded into the `%s` placeholder.
#[tauri::command]
pub async fn selection_toolbar_search_selection(
    app: AppHandle,
    state: State<'_, AppState>,
    selection_id: String,
) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;

    state.selection_toolbar.lock_interaction();
    let text = match state.selection_toolbar.selection_text(&selection_id).await {
        Some(text) => text,
        None => {
            state.selection_toolbar.unlock_interaction();
            return Err("The selected text is no longer active".to_string());
        }
    };
    let settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .map_err(|error| {
            state.selection_toolbar.unlock_interaction();
            error.to_string()
        })?;
    if !settings.selection_toolbar.enabled {
        state.selection_toolbar.unlock_interaction();
        return Err("Selection toolbar is disabled".into());
    }
    let search_enabled = settings.selection_toolbar.tools.iter().any(|tool| {
        matches!(
            tool,
            aqbot_core::types::SelectionToolbarTool::BuiltinAction {
                builtin_key: aqbot_core::types::SelectionToolbarBuiltinActionKey::Search,
                enabled: true,
            }
        )
    });
    if !search_enabled {
        state.selection_toolbar.unlock_interaction();
        return Err("The search tool is disabled".into());
    }
    let url = match aqbot_core::types::render_selection_toolbar_search_url(
        &settings.selection_toolbar.search_url,
        &text,
    ) {
        Ok(url) => url,
        Err(error) => {
            state.selection_toolbar.unlock_interaction();
            return Err(error);
        }
    };
    app.opener().open_url(url, None::<&str>).map_err(|error| {
        state.selection_toolbar.unlock_interaction();
        error.to_string()
    })
}

#[tauri::command]
pub async fn selection_toolbar_copy_result(
    app: AppHandle,
    state: State<'_, AppState>,
    request_id: String,
) -> Result<(), String> {
    let output = state
        .selection_toolbar
        .run_output(&request_id)
        .await
        .ok_or_else(|| "The selection toolbar result is no longer available".to_string())?;
    // Copy only the answer — reasoning blocks stay in the panel.
    let output = strip_think_content_for_copy(&output);
    app.clipboard()
        .write_text(output)
        .map_err(|error| error.to_string())
}

/// Strip closed `<think>` blocks and truncate an unterminated one (copying
/// while the model is still reasoning must not leak partial thinking).
fn strip_think_content_for_copy(output: &str) -> String {
    let stripped = crate::commands::conversations::strip_think_tags(output);
    if let Some(start) = stripped.find("<think") {
        let after_tag = &stripped[start + 6..];
        if after_tag.starts_with('>') || after_tag.starts_with(' ') {
            return stripped[..start].trim_end().to_string();
        }
    }
    stripped
}

#[cfg(test)]
mod tests {
    use super::strip_think_content_for_copy;

    #[test]
    fn copy_strips_closed_and_unterminated_think_blocks() {
        assert_eq!(
            strip_think_content_for_copy("<think totalMs=\"12\">\nreasoning\n</think>\n\nanswer"),
            "answer"
        );
        assert_eq!(
            strip_think_content_for_copy(
                "partial answer\n\n<think data-aqbot=\"1\">\nstill thinking"
            ),
            "partial answer"
        );
        assert_eq!(strip_think_content_for_copy("1 < thinky 2"), "1 < thinky 2");
    }
}

#[tauri::command]
pub async fn selection_toolbar_close(
    app: AppHandle,
    state: State<'_, AppState>,
    reason: String,
) -> Result<(), String> {
    state.selection_toolbar.hide(&app, &reason).await
}
