use aqbot_core::db;
use chrono;
use sea_orm::DatabaseConnection;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tauri::{Emitter, Manager};
use tokio::sync::Mutex;

#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;

use std::path::PathBuf;

#[derive(Clone)]
pub struct StreamCancelEntry {
    pub conversation_id: String,
    pub flag: Arc<AtomicBool>,
}

pub struct AppState {
    pub sea_db: DatabaseConnection,
    pub master_key: [u8; 32],
    pub gateway: Arc<Mutex<Option<aqbot_gateway::server::GatewayServer>>>,
    pub close_to_tray: Arc<AtomicBool>,
    pub release_webview_on_tray: Arc<AtomicBool>,
    pub main_window_released_to_tray: Arc<AtomicBool>,
    pub main_window_restoring: Arc<AtomicBool>,
    pub is_quitting: Arc<AtomicBool>,
    pub app_data_dir: PathBuf,
    pub db_path: String,
    pub auto_backup_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    pub webdav_sync_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    pub s3_sync_handle: Arc<Mutex<Option<tokio::task::JoinHandle<()>>>>,
    pub vector_store: Arc<aqbot_core::vector_store::VectorStore>,
    pub knowledge_index_scheduler: Arc<knowledge_index_scheduler::KnowledgeIndexScheduler>,
    pub stream_cancel_flags: Arc<Mutex<std::collections::HashMap<String, StreamCancelEntry>>>,
    pub agent_cancel_tokens:
        Arc<Mutex<std::collections::HashMap<String, open_agent_sdk::CancellationToken>>>,
    pub agent_permission_senders:
        Arc<Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<String>>>>,
    pub agent_ask_senders:
        Arc<Mutex<std::collections::HashMap<String, tokio::sync::oneshot::Sender<String>>>>,
    pub agent_always_allowed:
        Arc<Mutex<std::collections::HashMap<String, std::collections::HashSet<String>>>>,
}

mod commands;
mod context_manager;
mod diagnostics;
mod indexing;
pub mod knowledge_index_scheduler;
#[cfg(any(target_os = "linux", test))]
mod linux_webkit;
mod media_protocol;
mod paths;
mod startup_diagnostics;
mod tray;
mod window_lifecycle;
mod window_state;

#[cfg(target_os = "windows")]
mod windows_utils;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    diagnostics::init_tracing();
    diagnostics::install_panic_hook();
    diagnostics::log_process_startup();
    startup_diagnostics::log_startup_env_switches();

    #[cfg(target_os = "linux")]
    linux_webkit::apply_startup_workarounds();

    #[allow(unused_mut)]
    let mut builder = {
        tracing::info!("Creating Tauri application builder");
        let builder = tauri::Builder::default();
        tracing::info!("Created Tauri application builder");
        builder
    };
    builder = media_protocol::register(builder);

    let minimal_plugins = {
        #[cfg(target_os = "linux")]
        {
            startup_diagnostics::linux_minimal_plugins_enabled()
        }
        #[cfg(not(target_os = "linux"))]
        {
            false
        }
    };

    if minimal_plugins {
        tracing::warn!(
            env = startup_diagnostics::LINUX_MINIMAL_PLUGINS_ENV,
            "Skipping nonessential Tauri plugins for Linux startup diagnostics"
        );
    } else {
        builder = startup_diagnostics::register_plugin(
            builder,
            "single-instance",
            tauri_plugin_single_instance::init(|app, _args, _cwd| {
                tracing::info!("AQBot single-instance callback reached");
                window_lifecycle::restore_main_window(app);
            }),
        );
        builder = builder.plugin(startup_diagnostics::diagnostic_marker_plugin(
            "aqbot_diag_after_single_instance",
        ));

        builder = startup_diagnostics::register_plugin(
            builder,
            "deep-link",
            tauri_plugin_deep_link::init(),
        );
        builder = builder.plugin(startup_diagnostics::diagnostic_marker_plugin(
            "aqbot_diag_after_deep_link",
        ));

        builder =
            startup_diagnostics::register_plugin(builder, "opener", tauri_plugin_opener::init());
        builder = builder.plugin(startup_diagnostics::diagnostic_marker_plugin(
            "aqbot_diag_after_opener",
        ));

        builder =
            startup_diagnostics::register_plugin(builder, "dialog", tauri_plugin_dialog::init());
        builder = builder.plugin(startup_diagnostics::diagnostic_marker_plugin(
            "aqbot_diag_after_dialog",
        ));

        builder = startup_diagnostics::register_plugin(builder, "fs", tauri_plugin_fs::init());
        builder = builder.plugin(startup_diagnostics::diagnostic_marker_plugin(
            "aqbot_diag_after_fs",
        ));

        builder = startup_diagnostics::register_plugin(
            builder,
            "autostart",
            tauri_plugin_autostart::init(tauri_plugin_autostart::MacosLauncher::LaunchAgent, None),
        );
        builder = builder.plugin(startup_diagnostics::diagnostic_marker_plugin(
            "aqbot_diag_after_autostart",
        ));

        builder = startup_diagnostics::register_plugin(
            builder,
            "global-shortcut",
            tauri_plugin_global_shortcut::Builder::new().build(),
        );
        builder = builder.plugin(startup_diagnostics::diagnostic_marker_plugin(
            "aqbot_diag_after_global_shortcut",
        ));

        builder =
            startup_diagnostics::register_plugin(builder, "process", tauri_plugin_process::init());
        builder = builder.plugin(startup_diagnostics::diagnostic_marker_plugin(
            "aqbot_diag_after_process",
        ));

        builder = startup_diagnostics::register_plugin(
            builder,
            "clipboard-manager",
            tauri_plugin_clipboard_manager::init(),
        );
        builder = builder.plugin(startup_diagnostics::diagnostic_marker_plugin(
            "aqbot_diag_after_clipboard_manager",
        ));

        builder = startup_diagnostics::register_plugin(
            builder,
            "updater",
            tauri_plugin_updater::Builder::new().build(),
        );
        builder = builder.plugin(startup_diagnostics::diagnostic_marker_plugin(
            "aqbot_diag_after_updater",
        ));
    }

    #[cfg(debug_assertions)]
    if !minimal_plugins {
        builder = startup_diagnostics::register_plugin(
            builder,
            "mcp-bridge",
            tauri_plugin_mcp_bridge::init(),
        );
        builder = builder.plugin(startup_diagnostics::diagnostic_marker_plugin(
            "aqbot_diag_after_mcp_bridge",
        ));
    }

    #[cfg(target_os = "linux")]
    if startup_diagnostics::linux_any_thread_enabled() {
        tracing::warn!(
            env = startup_diagnostics::LINUX_ANY_THREAD_ENV,
            "Using Tauri any_thread runtime path for Linux startup diagnostics"
        );
        builder = builder.any_thread();
    }

    #[cfg(target_os = "linux")]
    let context = {
        tracing::info!("Generating Tauri context");
        let mut context = tauri::generate_context!();
        tracing::info!("Generated Tauri context");
        linux_webkit::configure_startup_window_creation(&mut context);
        tracing::info!("Configured Linux startup window creation");
        context
    };
    #[cfg(not(target_os = "linux"))]
    let context = {
        tracing::info!("Generating Tauri context");
        let context = tauri::generate_context!();
        tracing::info!("Generated Tauri context");
        context
    };

    let startup_phase = startup_diagnostics::StartupPhase::new("attaching invoke handler");
    let watchdog = startup_diagnostics::start_linux_startup_watchdog(startup_phase.clone());

    tracing::info!("Attaching Tauri invoke handler");
    startup_phase.set("attaching invoke handler");
    let builder = builder.invoke_handler(tauri::generate_handler![
        // providers
        commands::providers::list_providers,
        commands::providers::create_provider,
        commands::providers::import_provider_from_deep_link,
        commands::providers::scan_cc_switch_provider_imports,
        commands::providers::import_cc_switch_provider_configs,
        commands::providers::update_provider,
        commands::providers::delete_provider,
        commands::providers::toggle_provider,
        commands::providers::add_provider_key,
        commands::providers::update_provider_key,
        commands::providers::delete_provider_key,
        commands::providers::toggle_provider_key,
        commands::providers::get_decrypted_provider_key,
        commands::providers::validate_provider_key,
        commands::providers::save_models,
        commands::providers::toggle_model,
        commands::providers::update_model_params,
        commands::providers::fetch_remote_models,
        commands::providers::test_model,
        commands::providers::reorder_providers,
        // drawing
        commands::drawing::list_drawing_generations,
        commands::drawing::upload_drawing_reference,
        commands::drawing::generate_drawing_images,
        commands::drawing::edit_drawing_image,
        commands::drawing::edit_drawing_image_with_mask,
        commands::drawing::delete_drawing_generation,
        // conversations
        commands::conversations::list_conversations,
        commands::conversations::get_conversation_snapshot,
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
        commands::conversations::list_message_versions_batch,
        commands::conversations::switch_message_version,
        commands::conversations::delete_message_group,
        commands::conversations::send_system_message,
        commands::conversations::compress_context,
        commands::conversations::get_compression_summary,
        commands::conversations::get_context_usage,
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
        commands::gateway::decrypt_gateway_key,
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
        commands::gateway::get_codex_session_visibility_status,
        commands::gateway::repair_codex_session_visibility,
        commands::gateway::generate_self_signed_cert,
        // messages
        commands::messages::list_messages,
        commands::messages::list_inline_media_diagnostics,
        commands::messages::list_messages_page,
        commands::messages::list_message_summaries,
        commands::messages::list_messages_window,
        commands::messages::list_messages_after,
        commands::messages::delete_message,
        commands::messages::update_message_content,
        commands::messages::clear_conversation_messages,
        commands::messages::clear_conversation_first_rounds,
        commands::messages::export_conversation,
        commands::messages::get_conversation_stats,
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
        commands::conversations::generate_search_query,
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
        commands::cherry_import::scan_cherry_studio_import,
        commands::cherry_import::import_cherry_studio_backup,
        commands::chatgpt_import::scan_chatgpt_import,
        commands::chatgpt_import::import_chatgpt_export,
        commands::kelivo_import::scan_kelivo_import,
        commands::kelivo_import::import_kelivo_backup,
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
        // s3
        commands::s3::get_s3_config,
        commands::s3::save_s3_config,
        commands::s3::s3_check_connection,
        commands::s3::s3_backup,
        commands::s3::s3_list_backups,
        commands::s3::s3_restore,
        commands::s3::s3_delete_backup,
        commands::s3::get_s3_sync_status,
        commands::s3::restart_s3_sync,
        // desktop
        commands::desktop::get_desktop_capabilities,
        commands::desktop::send_desktop_notification,
        commands::desktop::get_window_state,
        commands::desktop::set_always_on_top,
        commands::desktop::set_close_to_tray,
        commands::desktop::set_release_webview_on_tray,
        commands::desktop::force_quit,
        commands::desktop::apply_startup_settings,
        commands::desktop::test_proxy,
        commands::desktop::open_devtools,
        commands::desktop::write_diagnostic_log,
        commands::desktop::list_system_fonts,
        commands::desktop::minimize_window,
        commands::desktop::toggle_maximize_window,
        // files
        commands::files::upload_file,
        commands::files::download_file,
        commands::files::fetch_remote_image,
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
        commands::storage::validate_documents_root,
        commands::storage::change_documents_root,
        commands::storage::reset_documents_root,
        // agent
        commands::agent::agent_query,
        commands::agent::agent_cancel,
        commands::agent::agent_update_session,
        commands::agent::agent_get_session,
        commands::agent::agent_ensure_workspace,
        commands::agent::agent_approve,
        commands::agent::agent_respond_ask,
        commands::agent::agent_backup_and_clear_sdk_context,
        commands::agent::agent_restore_sdk_context_from_backup,
        // skills
        commands::skills::list_skills,
        commands::skills::get_skill,
        commands::skills::toggle_skill,
        commands::skills::install_skill,
        commands::skills::uninstall_skill,
        commands::skills::uninstall_skill_group,
        commands::skills::open_skills_dir,
        commands::skills::open_skill_dir,
        commands::skills::search_marketplace,
        commands::skills::check_skill_updates,
        // roles
        commands::roles::list_roles,
        commands::roles::get_role,
        commands::roles::create_role,
        commands::roles::update_role,
        commands::roles::delete_role,
        commands::roles::list_role_marketplace_sources,
        commands::roles::search_role_marketplace,
        commands::roles::install_role,
    ]);
    tracing::info!("Attached Tauri invoke handler");

    tracing::info!("Attaching Tauri setup handler");
    startup_phase.set("attaching setup handler");
    let builder = builder.setup(|app| {
            tracing::info!("AQBot setup closure entered");

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
            match aqbot_core::pending_restore::apply_pending_restore(&app_dir) {
                Ok(aqbot_core::pending_restore::PendingRestoreOutcome::Applied) => {
                    tracing::info!("Pending restore applied before database startup")
                }
                Ok(aqbot_core::pending_restore::PendingRestoreOutcome::NotPending) => {}
                Ok(aqbot_core::pending_restore::PendingRestoreOutcome::FailedSafely {
                    error,
                    quarantine_path,
                    report_path,
                }) => tracing::error!(
                    error,
                    quarantine_path = %quarantine_path.display(),
                    report_path = ?report_path,
                    "Pending restore failed safely; continuing with the previous database"
                ),
                Err(error) => {
                    tracing::error!(error = %error, "Pending restore could not be rolled back safely");
                    panic!(
                        "FATAL: pending restore failed before database startup and a safe \
                         rollback could not be confirmed: {error}."
                    );
                }
            }
            tracing::info!(
                app_dir = %app_dir.display(),
                version = %app.package_info().version,
                "AQBot setup started"
            );

            // Ensure ~/Documents/aqbot/{images,files,backups}/ exist
            aqbot_core::storage_paths::ensure_documents_dirs()
                .expect("failed to create documents storage dirs");
            tracing::info!("AQBot documents directories ensured");

            let db_path = format!("sqlite:{}/aqbot.db", app_dir.display());
            tracing::info!(db_path = %db_path, "AQBot database path resolved");

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
                tracing::info!("AQBot master key loaded");
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
                tracing::info!("AQBot master key generated");
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
                    // Show native dialog so user sees the error
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
                    #[cfg(target_os = "windows")]
                    {
                        windows_utils::show_error_dialog("AQBot", &msg);
                    }
                    std::process::exit(1);
                }
            };
            tracing::info!("AQBot database pool initialized");

            // Initialize vector store (shares the sea-orm SQLite connection)
            let vector_store =
                aqbot_core::vector_store::VectorStore::new(db_handle.conn.clone());

            // Migrate any hardcoded absolute paths in settings to dynamic variables
            rt.block_on(aqbot_core::path_vars::migrate_hardcoded_paths(&db_handle.conn));

            let app_settings = rt
                .block_on(aqbot_core::repo::settings::get_settings(&db_handle.conn))
                .unwrap_or_default();

            // Apply custom documents root (if configured) before anything
            // that reads documents_root().
            aqbot_core::storage_paths::init_documents_root(
                app_settings.documents_root_override.as_ref().map(PathBuf::from),
            );

            // Re-ensure documents dirs under the (possibly custom) root
            aqbot_core::storage_paths::ensure_documents_dirs()
                .expect("failed to create documents storage dirs (custom root)");

            // One-time, idempotent migration of historical assistant images that were
            // embedded directly in message Markdown/HTML. Never mutate a candidate
            // unless a pre-migration SQLite backup succeeds.
            match rt.block_on(aqbot_core::inline_media::pending_inline_media_message_ids(
                &db_handle.conn,
                None,
            )) {
                Ok(message_ids) if !message_ids.is_empty() => {
                    let backup_dir = aqbot_core::path_vars::decode_path_opt(&app_settings.backup_dir)
                        .map(PathBuf::from)
                        .unwrap_or_else(|| {
                            aqbot_core::storage_paths::documents_root().join("backups")
                        });
                    match rt.block_on(aqbot_core::repo::backup::create_backup(
                        &db_handle.conn,
                        "sqlite",
                        &backup_dir,
                    )) {
                        Ok(backup) => {
                            tracing::info!(
                                backup_id = %backup.id,
                                candidate_count = message_ids.len(),
                                "Created backup before inline media migration"
                            );
                            let file_store = aqbot_core::file_store::FileStore::new();
                            match rt.block_on(
                                aqbot_core::inline_media::materialize_inline_media_messages(
                                    &db_handle.conn,
                                    &file_store,
                                    &message_ids,
                                ),
                            ) {
                                Ok(report) => {
                                    tracing::info!(
                                        migrated = report.migrated,
                                        failed = report.failures.len(),
                                        "Historical inline media migration finished"
                                    );
                                    for failure in report.failures {
                                        tracing::error!(
                                            message_id = %failure.message_id,
                                            error = %failure.error,
                                            "Historical inline media message was left unchanged"
                                        );
                                    }
                                }
                                Err(error) => tracing::error!(
                                    error = %error,
                                    "Historical inline media migration could not start"
                                ),
                            }
                        }
                        Err(error) => tracing::error!(
                            error = %error,
                            candidate_count = message_ids.len(),
                            "Skipped inline media migration because the safety backup failed"
                        ),
                    }
                }
                Ok(_) => {}
                Err(error) => tracing::error!(
                    error = %error,
                    "Failed to inspect historical inline media candidates"
                ),
            }

            let tray_language = app_settings.language.clone();

            app.manage(AppState {
                sea_db: db_handle.conn,
                master_key,
                gateway: Arc::new(Mutex::new(None)),
                close_to_tray: Arc::new(AtomicBool::new(app_settings.minimize_to_tray)),
                release_webview_on_tray: Arc::new(AtomicBool::new(app_settings.release_webview_on_tray)),
                main_window_released_to_tray: Arc::new(AtomicBool::new(false)),
                main_window_restoring: Arc::new(AtomicBool::new(false)),
                is_quitting: Arc::new(AtomicBool::new(false)),
                app_data_dir: app_dir.clone(),
                db_path: db_path,
                auto_backup_handle: Arc::new(Mutex::new(None)),
                webdav_sync_handle: Arc::new(Mutex::new(None)),
                s3_sync_handle: Arc::new(Mutex::new(None)),
                vector_store: Arc::new(vector_store),
                knowledge_index_scheduler: Arc::new(
                    knowledge_index_scheduler::KnowledgeIndexScheduler::default(),
                ),
                stream_cancel_flags: Arc::new(Mutex::new(std::collections::HashMap::new())),
                agent_cancel_tokens: Arc::new(Mutex::new(std::collections::HashMap::new())),
                agent_permission_senders: Arc::new(Mutex::new(std::collections::HashMap::new())),
                agent_ask_senders: Arc::new(Mutex::new(std::collections::HashMap::new())),
                agent_always_allowed: Arc::new(Mutex::new(std::collections::HashMap::new())),
            });

            // Reset any agent sessions that were running when app crashed/closed
            {
                let sea_db = app.state::<AppState>().sea_db.clone();
                let _ = rt.block_on(aqbot_core::repo::agent_session::reset_running_sessions(&sea_db));
                match rt.block_on(aqbot_core::repo::message::mark_stale_partial_assistant_messages_failed(&sea_db)) {
                    Ok(count) if count > 0 => {
                        tracing::info!(
                            count,
                            "Marked stale partial assistant messages as failed"
                        );
                    }
                    Ok(_) => {}
                    Err(err) => {
                        tracing::warn!(
                            error = %err,
                            "Failed to recover stale partial assistant messages"
                        );
                    }
                }
            }

            if let Err(err) = window_lifecycle::ensure_main_window_for_setup(app.handle()) {
                tracing::error!(
                    error = %err,
                    "Failed to ensure AQBot main window during setup"
                );
                #[cfg(target_os = "linux")]
                diagnostics::show_linux_startup_error_dialog(&format!(
                    "AQBot 主窗口创建失败：{}",
                    err
                ));
                return Err(std::io::Error::new(std::io::ErrorKind::Other, err).into());
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
                            let backup_dir_setting = aqbot_core::path_vars::decode_path_opt(&settings.backup_dir);
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
                            let interval_secs = interval as u64 * 60;

                            // Calculate initial delay: catch up if overdue
                            let initial_delay_secs = match aqbot_core::repo::settings::get_setting(&db, "webdav_last_sync_time").await {
                                Ok(Some(ts)) => {
                                    if let Ok(last_time) = chrono::DateTime::parse_from_rfc3339(&ts) {
                                        let elapsed = chrono::Utc::now()
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

                            let task = commands::webdav::spawn_webdav_sync_task(
                                db2, master_key, dir2, interval, initial_delay_secs,
                            );
                            *handle.lock().await = Some(task);
                        }
                    }
                });
            }

            // Initialize S3 sync scheduler if enabled
            {
                let state = app.state::<AppState>();
                let db = state.sea_db.clone();
                let master_key = state.master_key;
                let app_data_dir = app_dir.clone();
                let handle = state.s3_sync_handle.clone();
                tauri::async_runtime::spawn(async move {
                    if let Ok(settings) = aqbot_core::repo::settings::get_settings(&db).await {
                        if settings.s3_sync_enabled && settings.s3_sync_interval_minutes > 0 {
                            let db2 = db.clone();
                            let dir2 = app_data_dir.clone();
                            let interval = settings.s3_sync_interval_minutes;
                            let interval_secs = interval as u64 * 60;

                            let initial_delay_secs = match aqbot_core::repo::settings::get_setting(&db, "s3_last_sync_time").await {
                                Ok(Some(ts)) => {
                                    if let Ok(last_time) = chrono::DateTime::parse_from_rfc3339(&ts) {
                                        let elapsed = chrono::Utc::now()
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

                            let task = commands::s3::spawn_s3_sync_task(
                                db2, master_key, dir2, interval, initial_delay_secs,
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
        });
    tracing::info!("Attached Tauri setup handler");

    tracing::info!("Attaching Tauri window event handler");
    startup_phase.set("attaching window event handler");
    let builder = builder.on_window_event(|window, event| {
        if window.label() == "main" {
            match event {
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::Moved(_) => {
                    let app = window.app_handle();
                    let state = app.state::<AppState>();
                    let maximized = window.is_maximized().unwrap_or(false);
                    let fullscreen = window.is_fullscreen().unwrap_or(false);
                    let scale_factor = window.scale_factor().unwrap_or(1.0);

                    // Load previous state to preserve non-maximized geometry
                    let prev = window_state::load_window_state(&state.app_data_dir);

                    if maximized || fullscreen {
                        // Only flip flags; keep the last normal geometry
                        if let Some(mut prev) = prev {
                            prev.maximized = maximized;
                            prev.fullscreen = fullscreen;
                            let _ = window_state::save_window_state(&state.app_data_dir, prev);
                        }
                    } else if let (Ok(size), Ok(pos)) =
                        (window.inner_size(), window.outer_position())
                    {
                        let logical_w = size.width as f64 / scale_factor;
                        let logical_h = size.height as f64 / scale_factor;
                        let logical_x = pos.x as f64 / scale_factor;
                        let logical_y = pos.y as f64 / scale_factor;
                        let _ = window_state::save_window_state(
                            &state.app_data_dir,
                            window_state::PersistedWindowState {
                                width: logical_w,
                                height: logical_h,
                                maximized: false,
                                fullscreen: false,
                                x: Some(logical_x),
                                y: Some(logical_y),
                            },
                        );
                    }
                }
                tauri::WindowEvent::CloseRequested { api, .. } => {
                    let app = window.app_handle();
                    let state = app.state::<AppState>();
                    if state.close_to_tray.load(Ordering::Relaxed) {
                        let _ = window_lifecycle::release_main_window_to_tray(window);
                        api.prevent_close();
                    } else {
                        // Ask frontend for confirmation before quitting
                        api.prevent_close();
                        let _ = app.emit("app-close-requested", ());
                    }
                }
                _ => {}
            }
        }
    });
    tracing::info!("Attached Tauri window event handler");

    tracing::info!("Building Tauri application");
    startup_phase.set("inside builder.build(context)");
    let build_result = builder.build(context);
    startup_phase.set("builder.build(context) returned");
    watchdog.stop();

    let app = match build_result {
        Ok(app) => {
            tracing::info!("Tauri application build returned successfully");
            app
        }
        Err(e) => {
            let error_msg = e.to_string();
            let error_chain = startup_diagnostics::format_error_chain(&e);
            let backtrace = std::backtrace::Backtrace::force_capture();
            tracing::error!(
                error = %error_msg,
                error_chain = %error_chain,
                backtrace = %backtrace,
                "Failed to build Tauri application"
            );

            #[cfg(target_os = "windows")]
            {
                let lower = error_msg.to_lowercase();
                if lower.contains("webview2") || lower.contains("webview") || lower.contains("edge")
                {
                    let user_ok = windows_utils::show_warning_ok_cancel(
                        "AQBot",
                        "未检测到 Microsoft Edge WebView2 Runtime，AQBot 无法启动。\n\n\
                         点击「确定」打开下载页面进行安装，安装完成后重新启动 AQBot。",
                    );
                    if user_ok {
                        let _ = std::process::Command::new("cmd")
                            .args(["/c", "start", "https://developer.microsoft.com/en-us/microsoft-edge/webview2/?form=MA13LH#download"])
                            .spawn();
                    }
                } else {
                    windows_utils::show_error_dialog(
                        "AQBot",
                        &format!("应用启动失败：{}", error_msg),
                    );
                }
            }

            #[cfg(target_os = "linux")]
            diagnostics::show_linux_startup_error_dialog(&format!(
                "AQBot 启动失败：{}\n\n请使用 AQBOT_LOG_FILE 和 RUST_LOG=debug 启动后回传日志。",
                error_chain
            ));

            std::process::exit(1);
        }
    };

    tracing::info!("Starting Tauri application event loop");
    app.run(|app, event| {
        if let tauri::RunEvent::ExitRequested { api, .. } = &event {
            let state = app.state::<AppState>();
            if state.main_window_released_to_tray.load(Ordering::Relaxed)
                && !state.is_quitting.load(Ordering::Relaxed)
            {
                api.prevent_exit();
            }
        }

        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen {
            has_visible_windows,
            ..
        } = event
        {
            if !has_visible_windows {
                window_lifecycle::restore_main_window(app);
            }
        }
    });
}
