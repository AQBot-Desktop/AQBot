use aqbot_core::db;
use chrono;
use sea_orm::DatabaseConnection;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::Manager;
use tokio::sync::Mutex;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use std::path::PathBuf;
use tauri::{LogicalSize, Size};

pub struct AppState {
    pub sea_db: DatabaseConnection,
    pub master_key: [u8; 32],
    pub gateway: Arc<Mutex<Option<aqbot_gateway::server::GatewayServer>>>,
    pub close_to_tray: Arc<AtomicBool>,
    pub app_data_dir: PathBuf,
    pub db_path: String,
    pub auto_backup_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    pub webdav_sync_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    pub vector_store: Arc<aqbot_core::vector_store::VectorStore>,
    pub stream_cancel_flags: Arc<Mutex<std::collections::HashMap<String, Arc<AtomicBool>>>>,
}

mod commands;
mod context_manager;
mod indexing;
mod paths;
mod tray;
mod window_state;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    #[allow(unused_mut)]
    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ))
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build());

    #[cfg(debug_assertions)]
    {
        builder = builder.plugin(tauri_plugin_mcp_bridge::init());
    }

    builder
        .invoke_handler(tauri::generate_handler![
            // providers
            commands::providers::list_providers,
            commands::providers::create_provider,
            commands::providers::update_provider,
            commands::providers::delete_provider,
            commands::providers::toggle_provider,
            commands::providers::add_provider_key,
            commands::providers::delete_provider_key,
            commands::providers::toggle_provider_key,
            commands::providers::validate_provider_key,
            commands::providers::save_models,
            commands::providers::toggle_model,
            commands::providers::update_model_params,
            commands::providers::fetch_remote_models,
            commands::providers::test_model,
            commands::providers::reorder_providers,
            commands::providers::initialize_providers,
            // conversations
            commands::conversations::list_conversations,
            commands::conversations::create_conversation,
            commands::conversations::update_conversation,
            commands::conversations::delete_conversation,
            commands::conversations::branch_conversation,
            commands::conversations::search_conversations,
            commands::conversations::send_message,
            commands::conversations::toggle_pin_conversation,
            commands::conversations::toggle_archive_conversation,
            commands::conversations::list_archived_conversations,
            commands::conversations::regenerate_message,
            commands::conversations::regenerate_with_model,
            commands::conversations::cancel_stream,
            commands::conversations::list_message_versions,
            commands::conversations::switch_message_version,
            commands::conversations::delete_message_group,
            commands::conversations::send_system_message,
            commands::conversations::compress_context,
            commands::conversations::get_compression_summary,
            commands::conversations::delete_compression,
            commands::conversations::regenerate_conversation_title,
            // conversation categories
            commands::conversation_categories::list_conversation_categories,
            commands::conversation_categories::create_conversation_category,
            commands::conversation_categories::update_conversation_category,
            commands::conversation_categories::delete_conversation_category,
            commands::conversation_categories::reorder_conversation_categories,
            commands::conversation_categories::set_conversation_category_collapsed,
            // settings
            commands::settings::get_settings,
            commands::settings::save_settings,
            // gateway
            commands::gateway::list_gateway_keys,
            commands::gateway::create_gateway_key,
            commands::gateway::delete_gateway_key,
            commands::gateway::toggle_gateway_key,
            commands::gateway::get_gateway_metrics,
            commands::gateway::start_gateway,
            commands::gateway::stop_gateway,
            commands::gateway::get_gateway_status,
            commands::gateway::get_gateway_usage_by_key,
            commands::gateway::get_gateway_usage_by_provider,
            commands::gateway::get_gateway_usage_by_day,
            commands::gateway::get_connected_programs,
            commands::gateway::get_gateway_diagnostics,
            commands::gateway::get_program_policies,
            commands::gateway::save_program_policy,
            commands::gateway::delete_program_policy,
            commands::gateway::list_gateway_templates,
            commands::gateway::copy_gateway_template,
            commands::gateway::list_gateway_request_logs,
            commands::gateway::clear_gateway_request_logs,
            commands::gateway::get_all_cli_tool_statuses,
            commands::gateway::connect_cli_tool,
            commands::gateway::disconnect_cli_tool,
            commands::gateway::generate_self_signed_cert,
            // messages
            commands::messages::list_messages,
            commands::messages::list_messages_page,
            commands::messages::delete_message,
            commands::messages::clear_conversation_messages,
            commands::messages::export_conversation,
            // artifacts
            commands::artifacts::list_artifacts,
            commands::artifacts::create_artifact,
            commands::artifacts::update_artifact,
            commands::artifacts::delete_artifact,
            // context sources
            commands::context_sources::list_context_sources,
            commands::context_sources::add_context_source,
            commands::context_sources::remove_context_source,
            commands::context_sources::toggle_context_source,
            // branches & workspace
            commands::branches::list_branches,
            commands::branches::fork_conversation,
            commands::branches::compare_branches,
            commands::branches::get_workspace_snapshot,
            commands::branches::update_workspace_snapshot,
            // search providers
            commands::search::list_search_providers,
            commands::search::create_search_provider,
            commands::search::update_search_provider,
            commands::search::delete_search_provider,
            commands::search::test_search_provider,
            commands::search::execute_search,
            // mcp servers
            commands::mcp::list_mcp_servers,
            commands::mcp::create_mcp_server,
            commands::mcp::update_mcp_server,
            commands::mcp::delete_mcp_server,
            commands::mcp::test_mcp_server,
            commands::mcp::list_mcp_tools,
            commands::mcp::discover_mcp_tools,
            commands::mcp::list_tool_executions,
            // knowledge
            commands::knowledge::list_knowledge_bases,
            commands::knowledge::create_knowledge_base,
            commands::knowledge::update_knowledge_base,
            commands::knowledge::delete_knowledge_base,
            commands::knowledge::reorder_knowledge_bases,
            commands::knowledge::list_knowledge_documents,
            commands::knowledge::add_knowledge_document,
            commands::knowledge::delete_knowledge_document,
            commands::knowledge::search_knowledge_base,
            commands::knowledge::rebuild_knowledge_index,
            commands::knowledge::clear_knowledge_index,
            commands::knowledge::list_knowledge_document_chunks,
            commands::knowledge::delete_knowledge_chunk,
            commands::knowledge::update_knowledge_chunk,
            commands::knowledge::reindex_knowledge_chunk,
            commands::knowledge::rebuild_knowledge_document,
            commands::knowledge::add_knowledge_chunk,
            // memory
            commands::memory::list_memory_namespaces,
            commands::memory::create_memory_namespace,
            commands::memory::delete_memory_namespace,
            commands::memory::update_memory_namespace,
            commands::memory::list_memory_items,
            commands::memory::add_memory_item,
            commands::memory::delete_memory_item,
            commands::memory::update_memory_item,
            commands::memory::search_memory,
            commands::memory::rebuild_memory_index,
            commands::memory::clear_memory_index,
            commands::memory::reindex_memory_item,
            commands::memory::reorder_memory_namespaces,
            // backup
            commands::backup::list_backups,
            commands::backup::create_backup,
            commands::backup::restore_backup,
            commands::backup::delete_backup,
            commands::backup::batch_delete_backups,
            commands::backup::get_backup_settings,
            commands::backup::update_backup_settings,
            // webdav
            commands::webdav::get_webdav_config,
            commands::webdav::save_webdav_config,
            commands::webdav::webdav_check_connection,
            commands::webdav::webdav_backup,
            commands::webdav::webdav_list_backups,
            commands::webdav::webdav_restore,
            commands::webdav::webdav_delete_backup,
            commands::webdav::get_webdav_sync_status,
            commands::webdav::restart_webdav_sync,
            // desktop
            commands::desktop::get_desktop_capabilities,
            commands::desktop::send_desktop_notification,
            commands::desktop::get_window_state,
            commands::desktop::set_always_on_top,
            commands::desktop::set_close_to_tray,
            commands::desktop::apply_startup_settings,
            commands::desktop::test_proxy,
            commands::desktop::open_devtools,
            commands::desktop::list_system_fonts,
            // files
            commands::files::upload_file,
            commands::files::download_file,
            commands::files::list_files,
            commands::files::delete_file,
            // files page
            commands::files_page::list_files_page_entries,
            commands::files_page::open_files_page_entry,
            commands::files_page::reveal_files_page_entry,
            commands::files_page::cleanup_missing_files_page_entry,
            commands::files_page::check_attachment_exists,
            commands::files_page::resolve_attachment_path,
            commands::files_page::read_attachment_preview,
            commands::files_page::reveal_attachment_file,
            commands::files_page::save_avatar_file,
            commands::files_page::open_attachment_file,
            // storage
            commands::storage::get_storage_inventory,
            commands::storage::open_storage_directory,
        ])
        .setup(|app| {
            // Force overlay (auto-hide) scrollbar style on macOS.
            // Apps linked against older SDKs (e.g. macOS 15 CI builds) may
            // fall back to classic native scrollbars, ignoring CSS
            // ::-webkit-scrollbar styling.  Setting this user default before
            // the WebView is created ensures consistent thin overlay
            // scrollbars regardless of which SDK the binary was linked with.
            #[cfg(target_os = "macos")]
            {
                use objc2::msg_send;
                use objc2::rc::Retained;
                use objc2::runtime::{AnyClass, AnyObject};

                unsafe {
                    let defaults_cls = AnyClass::get(c"NSUserDefaults").unwrap();
                    let defaults: Retained<AnyObject> =
                        msg_send![defaults_cls, standardUserDefaults];

                    let str_cls = AnyClass::get(c"NSString").unwrap();
                    let key: Retained<AnyObject> =
                        msg_send![str_cls, stringWithUTF8String: c"AppleShowScrollBars".as_ptr()];
                    let value: Retained<AnyObject> =
                        msg_send![str_cls, stringWithUTF8String: c"WhenScrolling".as_ptr()];

                    let _: () = msg_send![&*defaults, setObject: &*value, forKey: &*key];
                }
            }

            // Canonical AQBot home directory (~/.aqbot/ on macOS/Linux,
            // %USERPROFILE%\.aqbot\ on Windows).
            let app_dir = paths::aqbot_home();
            std::fs::create_dir_all(&app_dir).expect("failed to create AQBot home dir");

            // Ensure ~/Documents/aqbot/{images,files,backups}/ exist
            aqbot_core::storage_paths::ensure_documents_dirs()
                .expect("failed to create documents storage dirs");

            let db_path = format!("sqlite:{}/aqbot.db", app_dir.display());

            // Load or generate master key BEFORE opening the database.
            // db::create_pool uses SQLite create mode, which would create aqbot.db
            // on first launch — causing the safety guard below to misfire if it ran
            // after the pool is opened.
            let key_path = app_dir.join("master.key");
            let master_key = if key_path.exists() {
                let mut bytes = std::fs::read(&key_path).expect("failed to read master key");
                if bytes.len() != 32 {
                    panic!(
                        "master.key is corrupted: expected 32 bytes, got {}. Delete the file to regenerate.",
                        bytes.len()
                    );
                }
                let mut key = [0u8; 32];
                key.copy_from_slice(&bytes);
                // Securely clear the temporary buffer
                bytes.iter_mut().for_each(|b| *b = 0);
                key
            } else {
                // Safety guard: refuse to generate a new key when an existing database is
                // present.  A fresh key would make every byte of encrypted data in the DB
                // permanently unrecoverable.
                // Note: we check for the DB file *before* create_pool so that a genuine
                // fresh install (no db, no key) can proceed normally.
                let db_file = app_dir.join("aqbot.db");
                if db_file.exists() {
                    panic!(
                        "FATAL: aqbot.db exists at '{}' but master.key is missing from '{}'.\n\
                         Generating a new master key would render all encrypted database \
                         contents permanently unrecoverable.\n\n\
                         Options:\n\
                         • Restore master.key from a backup and restart.\n\
                         • Remove aqbot.db (and aqbot.db-shm / aqbot.db-wal if present) \
                           to start fresh — ALL DATA WILL BE LOST.",
                        db_file.display(),
                        key_path.display()
                    );
                }
                let key = aqbot_core::crypto::generate_master_key();
                std::fs::write(&key_path, &key).expect("failed to write master key");
                // Restrict file permissions to owner-only (Unix)
                #[cfg(unix)]
                {
                    let perms = std::fs::Permissions::from_mode(0o600);
                    std::fs::set_permissions(&key_path, perms)
                        .expect("failed to set master.key permissions");
                }
                key
            };

            // Register sqlite-vec extension before any DB connections
            aqbot_core::vector_store::register_sqlite_vec_extension();

            let rt = tokio::runtime::Runtime::new().unwrap();
            let db_handle = match rt.block_on(db::create_pool(&db_path)) {
                Ok(h) => h,
                Err(e) => {
                    let msg = format!(
                        "数据库初始化失败: {}\n\n\
                         如果您从新版本回退到旧版本，数据库结构可能不兼容。\n\
                         请使用最新版本的 AQBot。",
                        e
                    );
                    tracing::error!("{}", msg);
                    // Show native dialog on macOS so user sees the error
                    #[cfg(target_os = "macos")]
                    {
                        let escaped = msg.replace('\"', "\\\"").replace('\n', "\\n");
                        let _ = std::process::Command::new("osascript")
                            .args(["-e", &format!(
                                "display dialog \"{}\" with title \"AQBot\" buttons {{\"OK\"}} default button \"OK\" with icon stop",
                                escaped
                            )])
                            .output();
                    }
                    std::process::exit(1);
                }
            };

            // Initialize vector store (shares the sea-orm SQLite connection)
            let vector_store =
                aqbot_core::vector_store::VectorStore::new(db_handle.conn.clone());

            let tray_language = rt
                .block_on(aqbot_core::repo::settings::get_settings(&db_handle.conn))
                .map(|settings| settings.language)
                .unwrap_or_else(|_| "zh-CN".to_string());

            app.manage(AppState {
                sea_db: db_handle.conn,
                master_key,
                gateway: Arc::new(Mutex::new(None)),
                close_to_tray: Arc::new(AtomicBool::new(true)),
                app_data_dir: app_dir.clone(),
                db_path: db_path,
                auto_backup_handle: Arc::new(Mutex::new(None)),
                webdav_sync_handle: Arc::new(Mutex::new(None)),
                vector_store: Arc::new(vector_store),
                stream_cancel_flags: Arc::new(Mutex::new(std::collections::HashMap::new())),
            });

            if let Some(main_window) = app.get_webview_window("main") {
                if let Some(saved_state) = window_state::load_window_state(&app_dir) {
                    let restored_state = if let Ok(Some(monitor)) = main_window.current_monitor() {
                        let monitor_size = monitor
                            .size()
                            .to_logical::<f64>(main_window.scale_factor().unwrap_or(1.0));
                        window_state::clamp_window_state_to_monitor(
                            saved_state,
                            monitor_size.width,
                            monitor_size.height,
                        )
                    } else {
                        saved_state
                    };

                    let _ = main_window.set_size(Size::Logical(LogicalSize::new(
                        restored_state.width,
                        restored_state.height,
                    )));
                    let _ = main_window.center();
                }
            }

            // Initialize auto-backup scheduler if enabled
            {
                let state = app.state::<AppState>();
                let db = state.sea_db.clone();
                let app_data = app_dir.clone();
                let handle = state.auto_backup_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(settings) = aqbot_core::repo::settings::get_settings(&db).await {
                        if settings.auto_backup_enabled && settings.auto_backup_interval_hours > 0 {
                            let backup_dir_setting = settings.backup_dir.clone();
                            let interval = settings.auto_backup_interval_hours;
                            let max_count = settings.auto_backup_max_count;
                            let interval_secs = interval as u64 * 3600;
                            let db2 = db.clone();
                            let app_dir2 = app_data.clone();

                            // Calculate initial delay: catch up if overdue
                            let initial_delay_secs = match aqbot_core::repo::backup::list_backups(&db).await {
                                Ok(backups) if !backups.is_empty() => {
                                    let last_ts = &backups[0].created_at;
                                    if let Ok(last_time) = chrono::NaiveDateTime::parse_from_str(last_ts, "%Y-%m-%d %H:%M:%S") {
                                        let elapsed = chrono::Utc::now()
                                            .naive_utc()
                                            .signed_duration_since(last_time)
                                            .num_seconds()
                                            .max(0) as u64;
                                        if elapsed >= interval_secs { 0 } else { interval_secs - elapsed }
                                    } else {
                                        interval_secs
                                    }
                                }
                                _ => interval_secs,
                            };

                            let task = tokio::spawn(async move {
                                let dur = std::time::Duration::from_secs(interval_secs);
                                // Initial wait (may be shorter if overdue)
                                tokio::time::sleep(std::time::Duration::from_secs(initial_delay_secs)).await;
                                loop {
                                    let backup_dir = aqbot_core::repo::backup::resolve_backup_dir(
                                        backup_dir_setting.as_deref(),
                                        &app_dir2,
                                    );
                                    if let Err(e) = aqbot_core::repo::backup::create_backup(
                                        &db2, "sqlite", &backup_dir,
                                    ).await {
                                        tracing::warn!("Auto-backup failed: {}", e);
                                    } else {
                                        tracing::info!("Auto-backup created");
                                        let _ = aqbot_core::repo::backup::cleanup_old_backups(
                                            &db2, max_count,
                                        ).await;
                                    }
                                    tokio::time::sleep(dur).await;
                                }
                            });
                            *handle.lock().await = Some(task);
                        }
                    }
                });
            }

            // Initialize WebDAV sync scheduler if enabled
            {
                let state = app.state::<AppState>();
                let db = state.sea_db.clone();
                let master_key = state.master_key;
                let app_data_dir = app_dir.clone();
                let handle = state.webdav_sync_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(settings) = aqbot_core::repo::settings::get_settings(&db).await {
                        if settings.webdav_sync_enabled && settings.webdav_sync_interval_minutes > 0 {
                            let db2 = db.clone();
                            let dir2 = app_data_dir.clone();
                            let interval = settings.webdav_sync_interval_minutes;
                            let task = commands::webdav::spawn_webdav_sync_task(
                                db2, master_key, dir2, interval,
                            );
                            *handle.lock().await = Some(task);
                        }
                    }
                });
            }

            // Initialize system tray
            let handle = app.handle();
            if let Err(e) = tray::create_tray(handle, &tray_language) {
                tracing::warn!("Failed to create system tray: {}", e);
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if matches!(event, tauri::WindowEvent::Resized(_)) {
                    let app = window.app_handle();
                    let state = app.state::<AppState>();
                    if let Ok(size) = window.inner_size() {
                        let scale_factor = window.scale_factor().unwrap_or(1.0);
                        let _ = window_state::save_window_state(
                            &state.app_data_dir,
                            window_state::logical_window_state_from_physical(
                                size.width,
                                size.height,
                                scale_factor,
                            ),
                        );
                    }
                }

                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    let app = window.app_handle();
                    let state = app.state::<AppState>();
                    if state.close_to_tray.load(Ordering::Relaxed) {
                        let _ = window.hide();
                        api.prevent_close();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            #[cfg(target_os = "macos")]
            if let tauri::RunEvent::Reopen { has_visible_windows, .. } = event {
                if !has_visible_windows {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                }
            }
        });
}
