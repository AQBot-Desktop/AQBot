use crate::AppState;
use aqbot_core::repo::multi_model_column_layout::{
    self, MultiModelColumnLayout, MultiModelColumnLayoutView,
};
use aqbot_core::types::*;
use std::sync::atomic::Ordering;
use tauri::AppHandle;
use tauri::Emitter;
use tauri::Manager;
use tauri::State;

pub const MULTI_MODEL_COLUMN_LAYOUT_EVENT: &str = "aqbot:multi-model-column-layout";

fn proxy_settings_changed(before: &AppSettings, after: &AppSettings) -> bool {
    before.proxy_type != after.proxy_type
        || before.proxy_address != after.proxy_address
        || before.proxy_port != after.proxy_port
}

#[tauri::command]
pub async fn get_settings(state: State<'_, AppState>) -> Result<AppSettings, String> {
    let mut settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;
    settings.backup_dir = aqbot_core::path_vars::decode_path_opt(&settings.backup_dir);
    settings.gateway_ssl_cert_path =
        aqbot_core::path_vars::decode_path_opt(&settings.gateway_ssl_cert_path);
    settings.gateway_ssl_key_path =
        aqbot_core::path_vars::decode_path_opt(&settings.gateway_ssl_key_path);
    settings.agent_workspace_root =
        aqbot_core::path_vars::decode_path_opt(&settings.agent_workspace_root);
    Ok(settings)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveSettingsResult {
    pub saved: bool,
    pub warnings: Vec<String>,
}

#[tauri::command]
pub async fn save_settings(
    app: AppHandle,
    state: State<'_, AppState>,
    mut settings: AppSettings,
) -> Result<SaveSettingsResult, String> {
    settings.selection_toolbar.validate()?;
    if settings.multi_model_sequential_interval_seconds
        > aqbot_core::types::MAX_MULTI_MODEL_SEQUENTIAL_INTERVAL_SECONDS
    {
        return Err(format!(
            "multi_model_sequential_interval_seconds must be 0..={}",
            aqbot_core::types::MAX_MULTI_MODEL_SEQUENTIAL_INTERVAL_SECONDS
        ));
    }
    let mut tray_runtime = crate::tray_icon::runtime().lock().await;
    let observed_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .map_err(|e| e.to_string())?;
    let acp_guard = if proxy_settings_changed(&observed_settings, &settings) {
        Some(crate::commands::acp::config_lock().lock().await)
    } else {
        None
    };
    let invalidated_agent_ids = if acp_guard.is_some() {
        let current_settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
            .await
            .map_err(|e| e.to_string())?;
        proxy_settings_changed(&current_settings, &settings)
            .then(crate::commands::acp::configured_agent_ids)
            .transpose()?
    } else {
        None
    };
    settings.backup_dir = aqbot_core::path_vars::encode_path_opt(&settings.backup_dir);
    settings.gateway_ssl_cert_path =
        aqbot_core::path_vars::encode_path_opt(&settings.gateway_ssl_cert_path);
    settings.gateway_ssl_key_path =
        aqbot_core::path_vars::encode_path_opt(&settings.gateway_ssl_key_path);
    settings.agent_workspace_root =
        aqbot_core::path_vars::encode_path_opt(&settings.agent_workspace_root);
    aqbot_core::repo::settings::save_settings(&state.sea_db, &settings)
        .await
        .map_err(|e| e.to_string())?;
    if let Some(agent_ids) = invalidated_agent_ids {
        crate::commands::acp::note_launch_config_changed();
        crate::commands::acp::invalidate_idle_agent_sessions(&agent_ids).await;
    }
    drop(acp_guard);

    let app_state = app.state::<AppState>();
    let mut warnings = Vec::new();
    let tray_available = match crate::tray_icon::reconcile_locked(&app, &settings, &mut tray_runtime).await {
        Ok(()) => settings.tray_enabled && crate::tray::tray_exists(&app),
        Err(error) => {
            tracing::warn!(error = %error, "Failed to reconcile system tray after settings save");
            let still_available = crate::tray::tray_exists(&app);
            warnings.push(
                if still_available {
                    "tray_icon_update_failed"
                } else {
                    "tray_create_failed"
                }
                .to_string(),
            );
            still_available
        }
    };
    app_state
        .tray_enabled
        .store(settings.tray_enabled, Ordering::Relaxed);
    app_state
        .tray_available
        .store(tray_available, Ordering::Relaxed);
    app_state
        .close_to_tray
        .store(settings.minimize_to_tray, Ordering::Relaxed);
    app_state
        .release_webview_on_tray
        .store(settings.release_webview_on_tray, Ordering::Relaxed);
    app_state.selection_toolbar.reconcile(&app, &settings).await;

    if tray_available {
        crate::tray::sync_tray_language(&app, &settings.language).map_err(|e| e.to_string())?;
    }
    Ok(SaveSettingsResult {
        saved: true,
        warnings,
    })
}

fn emit_column_layout(app: &AppHandle, layout: &MultiModelColumnLayout) {
    if let Err(error) = app.emit(MULTI_MODEL_COLUMN_LAYOUT_EVENT, layout) {
        tracing::warn!(error = %error, "Failed to emit multi-model column layout");
    }
}

#[tauri::command]
pub async fn get_multi_model_column_layout(
    state: State<'_, AppState>,
) -> Result<MultiModelColumnLayout, String> {
    multi_model_column_layout::get_layout(&state.sea_db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_multi_model_side_by_side_width_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    view: MultiModelColumnLayoutView,
    mode: MultiModelSideBySideWidthMode,
) -> Result<MultiModelColumnLayout, String> {
    let layout = multi_model_column_layout::set_width_mode(&state.sea_db, view, mode)
        .await
        .map_err(|e| e.to_string())?;
    emit_column_layout(&app, &layout);
    Ok(layout)
}

#[tauri::command]
pub async fn set_multi_model_column_width(
    app: AppHandle,
    state: State<'_, AppState>,
    view: MultiModelColumnLayoutView,
    provider_id: String,
    model_id: String,
    width_px: Option<i32>,
) -> Result<MultiModelColumnLayout, String> {
    let layout = multi_model_column_layout::set_column_width(
        &state.sea_db,
        view,
        &provider_id,
        &model_id,
        width_px,
    )
    .await
    .map_err(|e| e.to_string())?;
    emit_column_layout(&app, &layout);
    Ok(layout)
}

#[cfg(test)]
mod tests {
    use super::proxy_settings_changed;
    use aqbot_core::types::AppSettings;

    #[test]
    fn unrelated_settings_do_not_invalidate_acp_processes() {
        let before = AppSettings::default();
        let mut after = before.clone();
        after.language = "en-US".into();

        assert!(!proxy_settings_changed(&before, &after));
    }

    #[test]
    fn every_proxy_field_change_invalidates_acp_processes() {
        let base = AppSettings {
            proxy_type: Some("http".into()),
            proxy_address: Some("127.0.0.1".into()),
            proxy_port: Some(7890),
            ..AppSettings::default()
        };

        let mut changed_type = base.clone();
        changed_type.proxy_type = Some("system".into());
        assert!(proxy_settings_changed(&base, &changed_type));

        let mut changed_address = base.clone();
        changed_address.proxy_address = Some("10.0.0.2".into());
        assert!(proxy_settings_changed(&base, &changed_address));

        let mut changed_port = base.clone();
        changed_port.proxy_port = Some(1080);
        assert!(proxy_settings_changed(&base, &changed_port));
    }
}
