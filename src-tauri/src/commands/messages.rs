use crate::AppState;
use aqbot_core::types::*;
use sea_orm::{
    ColumnTrait, Condition, DatabaseConnection, EntityTrait, QueryFilter, TransactionTrait,
};
use std::collections::HashSet;
use tauri::State;

const INLINE_MEDIA_DIAGNOSTIC_PLACEHOLDER: &str =
    "[内嵌图片迁移失败，消息原文已保留；请查看诊断记录]";

fn collect_message_media_candidates(
    rows: &[aqbot_core::entity::messages::Model],
) -> Result<HashSet<String>, String> {
    let mut candidates = HashSet::new();
    for row in rows {
        candidates.extend(
            aqbot_core::repo::stored_file::message_stored_file_ids(&row.content, &row.attachments)
                .map_err(|error| {
                    format!("Message {} media references are invalid: {error}", row.id)
                })?,
        );
    }
    Ok(candidates)
}

async fn conversation_message_rows(
    db: &DatabaseConnection,
    conversation_id: &str,
) -> Result<Vec<aqbot_core::entity::messages::Model>, String> {
    aqbot_core::entity::messages::Entity::find()
        .filter(aqbot_core::entity::messages::Column::ConversationId.eq(conversation_id))
        .all(db)
        .await
        .map_err(|error| error.to_string())
}

async fn delete_unreferenced_media_candidates_locked(
    db: &DatabaseConnection,
    file_store: &aqbot_core::file_store::FileStore,
    candidates: &HashSet<String>,
) -> Result<(), String> {
    if candidates.is_empty() {
        return Ok(());
    }
    let txn = db.begin().await.map_err(|error| error.to_string())?;
    let paths =
        match aqbot_core::repo::stored_file::delete_unreferenced_candidates(&txn, candidates).await
        {
            Ok(paths) => paths,
            Err(error) => {
                let rollback = txn.rollback().await.err();
                return Err(format!(
                    "Failed to reconcile deleted message media: {error}; rollback error: {}",
                    rollback
                        .map(|error| error.to_string())
                        .unwrap_or_else(|| "none".to_string())
                ));
            }
        };
    txn.commit()
        .await
        .map_err(|error| format!("Failed to commit deleted message media cleanup: {error}"))?;

    let mut cleanup_errors = Vec::new();
    for path in paths {
        if let Err(error) = file_store.delete_file(&path) {
            cleanup_errors.push(format!("{path}: {error}"));
        }
    }
    if cleanup_errors.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "Stored-file rows were removed, but physical cleanup failed: {}",
            cleanup_errors.join(", ")
        ))
    }
}

pub(crate) async fn delete_message_with_media_cleanup(
    db: &DatabaseConnection,
    file_store: &aqbot_core::file_store::FileStore,
    id: &str,
) -> Result<(), String> {
    let _file_reference_guard = aqbot_core::repo::stored_file::lock_file_references().await;
    let row = aqbot_core::entity::messages::Entity::find_by_id(id)
        .one(db)
        .await
        .map_err(|error| error.to_string())?
        .ok_or_else(|| format!("Message {id} not found"))?;
    let candidates = collect_message_media_candidates(&[row])?;
    aqbot_core::repo::message::delete_message(db, id)
        .await
        .map_err(|error| error.to_string())?;
    delete_unreferenced_media_candidates_locked(db, file_store, &candidates).await
}

pub(crate) async fn delete_message_group_with_media_cleanup(
    db: &DatabaseConnection,
    file_store: &aqbot_core::file_store::FileStore,
    user_message_id: &str,
) -> Result<u64, String> {
    let _file_reference_guard = aqbot_core::repo::stored_file::lock_file_references().await;
    let rows = aqbot_core::entity::messages::Entity::find()
        .filter(
            Condition::any()
                .add(aqbot_core::entity::messages::Column::Id.eq(user_message_id))
                .add(aqbot_core::entity::messages::Column::ParentMessageId.eq(user_message_id)),
        )
        .all(db)
        .await
        .map_err(|error| error.to_string())?;
    if rows.is_empty() {
        return Err(format!("Message {user_message_id} not found"));
    }
    let candidates = collect_message_media_candidates(&rows)?;
    let deleted = aqbot_core::repo::message::delete_message_group(db, user_message_id)
        .await
        .map_err(|error| error.to_string())?;
    delete_unreferenced_media_candidates_locked(db, file_store, &candidates).await?;
    Ok(deleted)
}

async fn clear_conversation_messages_with_media_cleanup(
    db: &DatabaseConnection,
    file_store: &aqbot_core::file_store::FileStore,
    conversation_id: &str,
) -> Result<u64, String> {
    let _file_reference_guard = aqbot_core::repo::stored_file::lock_file_references().await;
    let candidates =
        collect_message_media_candidates(&conversation_message_rows(db, conversation_id).await?)?;
    let deleted = aqbot_core::repo::message::clear_conversation_messages(db, conversation_id)
        .await
        .map_err(|error| error.to_string())?;
    delete_unreferenced_media_candidates_locked(db, file_store, &candidates).await?;
    Ok(deleted)
}

async fn clear_conversation_first_rounds_with_media_cleanup(
    db: &DatabaseConnection,
    file_store: &aqbot_core::file_store::FileStore,
    conversation_id: &str,
    rounds: u64,
) -> Result<u64, String> {
    let _file_reference_guard = aqbot_core::repo::stored_file::lock_file_references().await;
    let before = conversation_message_rows(db, conversation_id).await?;
    let deleted =
        aqbot_core::repo::message::clear_conversation_first_rounds(db, conversation_id, rounds)
            .await
            .map_err(|error| error.to_string())?;
    if deleted == 0 {
        return Ok(0);
    }
    let remaining_ids = conversation_message_rows(db, conversation_id)
        .await?
        .into_iter()
        .map(|row| row.id)
        .collect::<HashSet<_>>();
    let removed_rows = before
        .into_iter()
        .filter(|row| !remaining_ids.contains(&row.id))
        .collect::<Vec<_>>();
    let candidates = collect_message_media_candidates(&removed_rows)?;
    delete_unreferenced_media_candidates_locked(db, file_store, &candidates).await?;
    Ok(deleted)
}

pub(crate) fn ensure_message_safe_for_ipc(message: &Message) -> Result<(), String> {
    let has_inline_data = aqbot_core::inline_media::contains_inline_image_data;
    let unsafe_field = [
        ("id", Some(message.id.as_str())),
        ("conversation_id", Some(message.conversation_id.as_str())),
        ("content", Some(message.content.as_str())),
        ("provider_id", message.provider_id.as_deref()),
        ("model_id", message.model_id.as_deref()),
        ("thinking", message.thinking.as_deref()),
        ("parent_message_id", message.parent_message_id.as_deref()),
        ("tool_calls_json", message.tool_calls_json.as_deref()),
        ("tool_call_id", message.tool_call_id.as_deref()),
        ("status", Some(message.status.as_str())),
    ]
    .into_iter()
    .find_map(|(field, value)| value.is_some_and(has_inline_data).then_some(field))
    .or_else(|| {
        message
            .attachments
            .iter()
            .any(|attachment| {
                has_inline_data(&attachment.id)
                    || has_inline_data(&attachment.file_type)
                    || has_inline_data(&attachment.file_name)
                    || has_inline_data(&attachment.file_path)
                    || attachment.data.as_deref().is_some_and(has_inline_data)
            })
            .then_some("attachments")
    });

    match unsafe_field {
        Some(field) => {
            let safe_id = if has_inline_data(&message.id) {
                "<unsafe-id>"
            } else {
                &message.id
            };
            Err(format!(
                "Message {safe_id} cannot be returned over IPC: unresolved inline media remains in {field}"
            ))
        }
        None => Ok(()),
    }
}

pub(crate) fn ensure_messages_safe_for_ipc(messages: &[Message]) -> Result<(), String> {
    messages.iter().try_for_each(ensure_message_safe_for_ipc)
}

pub(crate) fn ensure_message_page_safe_for_ipc(page: &MessagePage) -> Result<(), String> {
    ensure_messages_safe_for_ipc(&page.messages)
}

pub(crate) fn ensure_message_window_safe_for_ipc(window: &MessageWindow) -> Result<(), String> {
    ensure_messages_safe_for_ipc(&window.messages)
}

fn diagnostic_message_for_ipc(mut message: Message) -> Message {
    let sanitize = aqbot_core::inline_media::filter_complete_inline_data;
    for value in [
        &mut message.id,
        &mut message.conversation_id,
        &mut message.status,
    ] {
        *value = sanitize(value);
    }
    for value in [
        &mut message.provider_id,
        &mut message.model_id,
        &mut message.thinking,
        &mut message.parent_message_id,
        &mut message.tool_calls_json,
        &mut message.tool_call_id,
    ] {
        if let Some(value) = value {
            *value = sanitize(value);
        }
    }
    message.content = INLINE_MEDIA_DIAGNOSTIC_PLACEHOLDER.to_string();
    message.attachments.clear();
    message
}

async fn record_ipc_inline_media_diagnostic(
    db: &sea_orm::DatabaseConnection,
    message: &Message,
    source_content: &str,
    error: &str,
) {
    let safe_message_id = aqbot_core::inline_media::filter_complete_inline_data(&message.id);
    tracing::error!(
        message_id = %safe_message_id,
        error,
        "Inline media could not be materialized for IPC; returning diagnostic placeholder"
    );
    if let Err(diagnostic_error) = aqbot_core::inline_media::record_inline_media_failure(
        db,
        &message.id,
        source_content,
        error,
    )
    .await
    {
        tracing::error!(
            message_id = %safe_message_id,
            error = %diagnostic_error,
            "Failed to persist inline media diagnostic"
        );
    }
}

pub(crate) async fn materialize_message_for_ipc(
    db: &sea_orm::DatabaseConnection,
    mut message: Message,
) -> Result<Message, String> {
    let source_content = message.content.clone();
    if ensure_message_safe_for_ipc(&message).is_err() {
        match aqbot_core::inline_media::matching_inline_media_diagnostic(
            db,
            &message.id,
            &source_content,
        )
        .await
        {
            Ok(Some(_)) => return Ok(diagnostic_message_for_ipc(message)),
            Ok(None) => {}
            Err(error) => {
                let safe_message_id =
                    aqbot_core::inline_media::filter_complete_inline_data(&message.id);
                tracing::error!(
                    message_id = %safe_message_id,
                    error = %error,
                    "Failed to inspect persisted inline media diagnostic"
                );
            }
        }
    }
    if aqbot_core::inline_media::contains_inline_image_data(&message.content) {
        let persistence =
            match aqbot_core::inline_media::prepare_message_inline_images(&source_content) {
                Ok(Some(_)) => {
                    let file_store = aqbot_core::file_store::FileStore::new();
                    aqbot_core::inline_media::materialize_message_inline_images(
                        db,
                        &file_store,
                        &message.id,
                        &source_content,
                    )
                    .await
                    .map(Some)
                }
                Ok(None) => Ok(None),
                Err(error) => Err(error),
            };
        match persistence {
            Ok(Some(materialized)) => message = materialized,
            Ok(None) => {
                message.content =
                    aqbot_core::inline_media::filter_complete_inline_data(&source_content);
            }
            Err(error) => {
                let error = error.to_string();
                record_ipc_inline_media_diagnostic(db, &message, &source_content, &error).await;
                message = diagnostic_message_for_ipc(message);
            }
        }
    }
    if aqbot_core::inline_media::contains_inline_image_data(&message.content) {
        message.content = aqbot_core::inline_media::filter_complete_inline_data(&message.content);
    }
    if let Err(error) = ensure_message_safe_for_ipc(&message) {
        record_ipc_inline_media_diagnostic(db, &message, &source_content, &error).await;
        message = diagnostic_message_for_ipc(message);
    }
    ensure_message_safe_for_ipc(&message)?;
    Ok(message)
}

pub(crate) async fn materialize_messages_for_ipc(
    db: &sea_orm::DatabaseConnection,
    messages: Vec<Message>,
) -> Result<Vec<Message>, String> {
    let mut prepared = Vec::with_capacity(messages.len());
    for message in messages {
        prepared.push(materialize_message_for_ipc(db, message).await?);
    }
    Ok(prepared)
}

fn ensure_message_summaries_safe_for_ipc(summaries: &[MessageSummary]) -> Result<(), String> {
    for summary in summaries {
        let has_inline_data = aqbot_core::inline_media::contains_inline_image_data;
        let unsafe_field = [
            ("id", Some(summary.id.as_str())),
            ("content_preview", Some(summary.content_preview.as_str())),
            ("provider_id", summary.provider_id.as_deref()),
            ("model_id", summary.model_id.as_deref()),
            ("parent_message_id", summary.parent_message_id.as_deref()),
        ]
        .into_iter()
        .find_map(|(field, value)| value.is_some_and(has_inline_data).then_some(field));
        if let Some(field) = unsafe_field {
            let safe_id = if has_inline_data(&summary.id) {
                "<unsafe-id>"
            } else {
                &summary.id
            };
            return Err(format!(
                "Message {safe_id} cannot be returned over IPC: unresolved inline media remains in {field}"
            ));
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn list_messages(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<Message>, String> {
    let messages = aqbot_core::repo::message::list_messages(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;
    let messages = materialize_messages_for_ipc(&state.sea_db, messages).await?;
    Ok(messages)
}

#[tauri::command]
pub async fn list_inline_media_diagnostics(
    state: State<'_, AppState>,
    conversation_id: Option<String>,
) -> Result<Vec<aqbot_core::inline_media::InlineMediaDiagnostic>, String> {
    aqbot_core::inline_media::list_inline_media_diagnostics(
        &state.sea_db,
        conversation_id.as_deref(),
    )
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn list_messages_page(
    state: State<'_, AppState>,
    conversation_id: String,
    limit: Option<u64>,
    before_message_id: Option<String>,
) -> Result<MessagePage, String> {
    let mut page = aqbot_core::repo::message::list_messages_page(
        &state.sea_db,
        &conversation_id,
        limit.unwrap_or(10),
        before_message_id.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;
    page.messages = materialize_messages_for_ipc(&state.sea_db, page.messages).await?;
    ensure_message_page_safe_for_ipc(&page)?;
    Ok(page)
}

#[tauri::command]
pub async fn list_message_summaries(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<MessageSummary>, String> {
    let mut summaries =
        aqbot_core::repo::message::list_message_summaries(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;
    for summary in &mut summaries {
        summary.content_preview =
            aqbot_core::inline_media::filter_complete_inline_data(&summary.content_preview);
    }
    ensure_message_summaries_safe_for_ipc(&summaries)?;
    Ok(summaries)
}

#[tauri::command]
pub async fn list_messages_window(
    state: State<'_, AppState>,
    conversation_id: String,
    anchor_message_id: String,
    before_limit: Option<u64>,
    after_limit: Option<u64>,
) -> Result<MessageWindow, String> {
    let mut window = aqbot_core::repo::message::list_messages_window(
        &state.sea_db,
        &conversation_id,
        &anchor_message_id,
        before_limit.unwrap_or(4),
        after_limit.unwrap_or(8),
    )
    .await
    .map_err(|e| e.to_string())?;
    window.messages = materialize_messages_for_ipc(&state.sea_db, window.messages).await?;
    ensure_message_window_safe_for_ipc(&window)?;
    Ok(window)
}

#[tauri::command]
pub async fn list_messages_after(
    state: State<'_, AppState>,
    conversation_id: String,
    after_message_id: String,
    limit: Option<u64>,
) -> Result<MessageWindow, String> {
    let mut window = aqbot_core::repo::message::list_messages_after(
        &state.sea_db,
        &conversation_id,
        &after_message_id,
        limit.unwrap_or(10),
    )
    .await
    .map_err(|e| e.to_string())?;
    window.messages = materialize_messages_for_ipc(&state.sea_db, window.messages).await?;
    ensure_message_window_safe_for_ipc(&window)?;
    Ok(window)
}

#[tauri::command]
pub async fn delete_message(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let file_store = aqbot_core::file_store::FileStore::new();
    delete_message_with_media_cleanup(&state.sea_db, &file_store, &id).await
}

#[tauri::command]
pub async fn update_message_content(
    state: State<'_, AppState>,
    id: String,
    content: String,
) -> Result<Message, String> {
    let file_store = aqbot_core::file_store::FileStore::new();
    let message = aqbot_core::inline_media::materialize_message_inline_images(
        &state.sea_db,
        &file_store,
        &id,
        &content,
    )
    .await
    .map_err(|error| format!("Message {id} inline media persistence failed: {error}"))?;
    materialize_message_for_ipc(&state.sea_db, message).await
}

#[tauri::command]
pub async fn clear_conversation_messages(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<u64, String> {
    let file_store = aqbot_core::file_store::FileStore::new();
    let rows = clear_conversation_messages_with_media_cleanup(
        &state.sea_db,
        &file_store,
        &conversation_id,
    )
    .await?;

    // Also clear the agent session's SDK context so the agent doesn't retain old history
    let _ = aqbot_core::repo::agent_session::clear_sdk_context_by_conversation_id(
        &state.sea_db,
        &conversation_id,
    )
    .await;

    Ok(rows)
}

#[tauri::command]
pub async fn clear_conversation_first_rounds(
    state: State<'_, AppState>,
    conversation_id: String,
    rounds: u64,
) -> Result<u64, String> {
    let file_store = aqbot_core::file_store::FileStore::new();
    let rows = clear_conversation_first_rounds_with_media_cleanup(
        &state.sea_db,
        &file_store,
        &conversation_id,
        rounds,
    )
    .await?;

    let _ = aqbot_core::repo::agent_session::clear_sdk_context_by_conversation_id(
        &state.sea_db,
        &conversation_id,
    )
    .await;

    Ok(rows)
}

#[tauri::command]
pub async fn export_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
    format: String,
) -> Result<String, String> {
    let conversation =
        aqbot_core::repo::conversation::get_conversation(&state.sea_db, &conversation_id)
            .await
            .map_err(|e| e.to_string())?;
    let messages = aqbot_core::repo::message::list_messages(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;
    let messages = materialize_messages_for_ipc(&state.sea_db, messages).await?;

    match format.as_str() {
        "json" => serde_json::to_string_pretty(&serde_json::json!({
            "conversation": conversation,
            "messages": messages,
        }))
        .map_err(|e| e.to_string()),
        "markdown" => {
            let mut md = format!("# {}\n\n", conversation.title);
            for msg in &messages {
                let role = match msg.role {
                    MessageRole::System => "System",
                    MessageRole::User => "User",
                    MessageRole::Assistant => "Assistant",
                    MessageRole::Tool => "Tool",
                };
                md.push_str(&format!("## {}\n\n{}\n\n", role, msg.content));
            }
            Ok(md)
        }
        _ => Err(format!("Unsupported export format: {}", format)),
    }
}

#[tauri::command]
pub async fn get_conversation_stats(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<ConversationStats, String> {
    aqbot_core::repo::message::get_conversation_stats(&state.sea_db, &conversation_id)
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod media_lifecycle_tests {
    use super::*;
    use aqbot_core::repo::{conversation, drawing, message, stored_file};
    use sea_orm::{ActiveModelTrait, ActiveValue::Set};

    async fn create_file_reference(
        db: &DatabaseConnection,
        file_store: &aqbot_core::file_store::FileStore,
        id: &str,
        bytes: &[u8],
        conversation_id: &str,
    ) -> aqbot_core::repo::stored_file::StoredFile {
        let saved = file_store
            .save_file(bytes, "image.png", "image/png")
            .unwrap();
        stored_file::create_stored_file(
            db,
            id,
            &saved.hash,
            "image.png",
            "image/png",
            saved.size_bytes,
            &saved.storage_path,
            Some(conversation_id),
        )
        .await
        .unwrap()
    }

    fn attachment(id: &str, path: &str) -> Attachment {
        Attachment {
            id: id.to_string(),
            file_type: "image/png".to_string(),
            file_name: "image.png".to_string(),
            file_path: path.to_string(),
            file_size: 4,
            data: None,
        }
    }

    #[tokio::test]
    async fn shared_message_reference_is_kept_until_last_message_is_deleted() {
        let h = aqbot_core::db::create_test_pool().await.unwrap();
        let db = &h.conn;
        let temp = tempfile::tempdir().unwrap();
        let file_store = aqbot_core::file_store::FileStore::with_root(temp.path().to_path_buf());
        let conversation = conversation::create_conversation(db, "shared", "m", "p", None)
            .await
            .unwrap();
        let stored =
            create_file_reference(db, &file_store, "shared-file", b"same", &conversation.id).await;
        let content_message = message::create_message(
            db,
            &conversation.id,
            MessageRole::User,
            "![image](aqbot-media://stored/shared-file)",
            &[],
            None,
            0,
        )
        .await
        .unwrap();
        let attachment_message = message::create_message(
            db,
            &conversation.id,
            MessageRole::User,
            "also attached",
            &[attachment("shared-file", &stored.storage_path)],
            None,
            0,
        )
        .await
        .unwrap();

        delete_message_with_media_cleanup(db, &file_store, &content_message.id)
            .await
            .unwrap();
        assert!(stored_file::get_stored_file(db, "shared-file")
            .await
            .is_ok());
        assert!(file_store.resolve_path(&stored.storage_path).exists());

        delete_message_with_media_cleanup(db, &file_store, &attachment_message.id)
            .await
            .unwrap();
        assert!(stored_file::get_stored_file(db, "shared-file")
            .await
            .is_err());
        assert!(!file_store.resolve_path(&stored.storage_path).exists());
    }

    #[tokio::test]
    async fn branch_row_and_drawing_reference_prevent_physical_media_deletion() {
        let h = aqbot_core::db::create_test_pool().await.unwrap();
        let db = &h.conn;
        let temp = tempfile::tempdir().unwrap();
        let file_store = aqbot_core::file_store::FileStore::with_root(temp.path().to_path_buf());
        let source = conversation::create_conversation(db, "source", "m", "p", None)
            .await
            .unwrap();
        let branch = conversation::create_conversation(db, "branch", "m", "p", None)
            .await
            .unwrap();
        let source_file =
            create_file_reference(db, &file_store, "source-file", b"same", &source.id).await;
        stored_file::create_stored_file(
            db,
            "branch-file",
            &source_file.hash,
            "image.png",
            "image/png",
            source_file.size_bytes,
            &source_file.storage_path,
            Some(&branch.id),
        )
        .await
        .unwrap();
        let source_message = message::create_message(
            db,
            &source.id,
            MessageRole::User,
            "![source](aqbot-media://stored/source-file)",
            &[],
            None,
            0,
        )
        .await
        .unwrap();
        let branch_message = message::create_message(
            db,
            &branch.id,
            MessageRole::User,
            "![branch](aqbot-media://stored/branch-file)",
            &[],
            None,
            0,
        )
        .await
        .unwrap();

        delete_message_with_media_cleanup(db, &file_store, &source_message.id)
            .await
            .unwrap();
        assert!(stored_file::get_stored_file(db, "source-file")
            .await
            .is_err());
        assert!(file_store.resolve_path(&source_file.storage_path).exists());

        let generation = drawing::create_generation(
            db,
            drawing::NewDrawingGeneration {
                parent_generation_id: None,
                provider_id: "p".to_string(),
                key_id: "k".to_string(),
                model_id: "m".to_string(),
                action: "generate".to_string(),
                prompt: "draw".to_string(),
                parameters_json: "{}".to_string(),
                reference_file_ids_json: r#"["branch-file"]"#.to_string(),
                source_image_ids_json: "[]".to_string(),
                mask_file_id: None,
            },
        )
        .await
        .unwrap();
        delete_message_with_media_cleanup(db, &file_store, &branch_message.id)
            .await
            .unwrap();
        assert!(stored_file::get_stored_file(db, "branch-file")
            .await
            .is_ok());
        assert!(file_store.resolve_path(&source_file.storage_path).exists());

        aqbot_core::entity::drawing_generations::Entity::delete_by_id(generation.id)
            .exec(db)
            .await
            .unwrap();
        let candidates = HashSet::from(["branch-file".to_string()]);
        let _guard = stored_file::lock_file_references().await;
        delete_unreferenced_media_candidates_locked(db, &file_store, &candidates)
            .await
            .unwrap();
        assert!(stored_file::get_stored_file(db, "branch-file")
            .await
            .is_err());
        assert!(!file_store.resolve_path(&source_file.storage_path).exists());
    }

    #[tokio::test]
    async fn clearing_first_round_only_collects_media_from_deleted_rows() {
        let h = aqbot_core::db::create_test_pool().await.unwrap();
        let db = &h.conn;
        let temp = tempfile::tempdir().unwrap();
        let file_store = aqbot_core::file_store::FileStore::with_root(temp.path().to_path_buf());
        let conversation = conversation::create_conversation(db, "rounds", "m", "p", None)
            .await
            .unwrap();
        let first_file =
            create_file_reference(db, &file_store, "first-file", b"one", &conversation.id).await;
        let second_file =
            create_file_reference(db, &file_store, "second-file", b"two", &conversation.id).await;
        let first = message::create_message(
            db,
            &conversation.id,
            MessageRole::User,
            "aqbot-media://stored/first-file",
            &[],
            None,
            0,
        )
        .await
        .unwrap();
        let second = message::create_message(
            db,
            &conversation.id,
            MessageRole::User,
            "aqbot-media://stored/second-file",
            &[],
            None,
            0,
        )
        .await
        .unwrap();
        for (id, created_at) in [(&first.id, 1_i64), (&second.id, 2_i64)] {
            let row = aqbot_core::entity::messages::Entity::find_by_id(id)
                .one(db)
                .await
                .unwrap()
                .unwrap();
            let mut active: aqbot_core::entity::messages::ActiveModel = row.into();
            active.created_at = Set(created_at);
            active.update(db).await.unwrap();
        }

        let deleted = clear_conversation_first_rounds_with_media_cleanup(
            db,
            &file_store,
            &conversation.id,
            1,
        )
        .await
        .unwrap();

        assert_eq!(deleted, 1);
        assert!(stored_file::get_stored_file(db, "first-file")
            .await
            .is_err());
        assert!(!file_store.resolve_path(&first_file.storage_path).exists());
        assert!(stored_file::get_stored_file(db, "second-file")
            .await
            .is_ok());
        assert!(file_store.resolve_path(&second_file.storage_path).exists());
    }

    #[tokio::test]
    async fn deleting_message_group_reclaims_media_from_user_and_assistant_versions() {
        let h = aqbot_core::db::create_test_pool().await.unwrap();
        let db = &h.conn;
        let temp = tempfile::tempdir().unwrap();
        let file_store = aqbot_core::file_store::FileStore::with_root(temp.path().to_path_buf());
        let conversation = conversation::create_conversation(db, "group", "m", "p", None)
            .await
            .unwrap();
        let user_file =
            create_file_reference(db, &file_store, "group-user", b"user", &conversation.id).await;
        let assistant_file = create_file_reference(
            db,
            &file_store,
            "group-assistant",
            b"assistant",
            &conversation.id,
        )
        .await;
        let user = message::create_message(
            db,
            &conversation.id,
            MessageRole::User,
            "aqbot-media://stored/group-user",
            &[],
            None,
            0,
        )
        .await
        .unwrap();
        message::create_message(
            db,
            &conversation.id,
            MessageRole::Assistant,
            "aqbot-media://stored/group-assistant",
            &[],
            Some(&user.id),
            0,
        )
        .await
        .unwrap();

        let deleted = delete_message_group_with_media_cleanup(db, &file_store, &user.id)
            .await
            .unwrap();

        assert_eq!(deleted, 2);
        assert!(stored_file::get_stored_file(db, "group-user")
            .await
            .is_err());
        assert!(stored_file::get_stored_file(db, "group-assistant")
            .await
            .is_err());
        assert!(!file_store.resolve_path(&user_file.storage_path).exists());
        assert!(!file_store
            .resolve_path(&assistant_file.storage_path)
            .exists());
    }
}

#[cfg(test)]
mod ipc_tests {
    use super::*;

    fn message_with_content(content: &str) -> Message {
        Message {
            id: "message-with-media".to_string(),
            conversation_id: "conversation-1".to_string(),
            role: MessageRole::Assistant,
            content: content.to_string(),
            provider_id: None,
            model_id: None,
            token_count: None,
            prompt_tokens: None,
            completion_tokens: None,
            attachments: Vec::new(),
            thinking: None,
            created_at: 0,
            parent_message_id: None,
            version_index: 0,
            is_active: true,
            tool_calls_json: None,
            tool_call_id: None,
            status: "complete".to_string(),
            tokens_per_second: None,
            first_token_latency_ms: None,
        }
    }

    #[test]
    fn message_ipc_gate_rejects_raw_data_uri_with_message_id() {
        let message = message_with_content("data:image/png;base64,SECRET");

        let error = ensure_message_safe_for_ipc(&message).unwrap_err();

        assert!(error.contains("message-with-media"));
        assert!(!error.contains("SECRET"));
    }

    #[test]
    fn every_message_ipc_container_is_checked_before_serialization() {
        let message = message_with_content("DATA:IMAGE/PNG;base64,SECRET");
        let page = MessagePage {
            messages: vec![message.clone()],
            has_older: false,
            oldest_message_id: Some(message.id.clone()),
            total_active_count: 1,
        };
        let window = MessageWindow {
            messages: vec![message.clone()],
            has_older: false,
            has_newer: false,
            oldest_message_id: Some(message.id.clone()),
            newest_message_id: Some(message.id.clone()),
            total_active_count: 1,
        };

        assert!(ensure_messages_safe_for_ipc(std::slice::from_ref(&message)).is_err());
        assert!(ensure_message_page_safe_for_ipc(&page).is_err());
        assert!(ensure_message_window_safe_for_ipc(&window).is_err());
    }

    #[test]
    fn every_attachment_string_field_is_checked_before_serialization() {
        for field in ["id", "file_type", "file_name", "file_path", "data"] {
            let mut message = message_with_content("safe");
            let raw = "data:image/png;base64,SECRET".to_string();
            let mut attachment = Attachment {
                id: "attachment-1".to_string(),
                file_type: "image/png".to_string(),
                file_name: "image.png".to_string(),
                file_path: "images/image.png".to_string(),
                file_size: 1,
                data: None,
            };
            match field {
                "id" => attachment.id = raw,
                "file_type" => attachment.file_type = raw,
                "file_name" => attachment.file_name = raw,
                "file_path" => attachment.file_path = raw,
                "data" => attachment.data = Some(raw),
                _ => unreachable!(),
            }
            message.attachments.push(attachment);

            let error = ensure_message_safe_for_ipc(&message).unwrap_err();

            assert!(error.contains("message-with-media"), "field: {field}");
            assert!(!error.contains("SECRET"), "field: {field}");
        }
    }

    #[test]
    fn every_message_string_field_is_checked_before_serialization() {
        for field in [
            "id",
            "conversation_id",
            "content",
            "provider_id",
            "model_id",
            "thinking",
            "parent_message_id",
            "tool_calls_json",
            "tool_call_id",
            "status",
        ] {
            let mut message = message_with_content("safe");
            let raw = "data:image/png;base64,SECRET".to_string();
            match field {
                "id" => message.id = raw,
                "conversation_id" => message.conversation_id = raw,
                "content" => message.content = raw,
                "provider_id" => message.provider_id = Some(raw),
                "model_id" => message.model_id = Some(raw),
                "thinking" => message.thinking = Some(raw),
                "parent_message_id" => message.parent_message_id = Some(raw),
                "tool_calls_json" => message.tool_calls_json = Some(raw),
                "tool_call_id" => message.tool_call_id = Some(raw),
                "status" => message.status = raw,
                _ => unreachable!(),
            }

            let error = ensure_message_safe_for_ipc(&message).unwrap_err();

            assert!(!error.contains("SECRET"), "field: {field}");
        }
    }

    #[tokio::test]
    async fn code_example_data_uri_is_redacted_instead_of_blocking_message_ipc() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let message = message_with_content("`![example](data:image/png;base64,iVBORw0KGgo=)`");

        let prepared = materialize_message_for_ipc(&db, message).await.unwrap();

        assert!(!prepared
            .content
            .to_ascii_lowercase()
            .contains("data:image/"));
        assert!(prepared.content.contains("[图片接收中]"));
    }

    #[tokio::test]
    async fn one_failed_inline_media_message_does_not_block_the_ipc_batch() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &db,
            "IPC diagnostics",
            "m1",
            "p1",
            None,
        )
        .await
        .unwrap();
        let invalid_content = "![bad](data:image/png;base64,broken!)";
        let invalid = aqbot_core::repo::message::create_message(
            &db,
            &conversation.id,
            MessageRole::Assistant,
            invalid_content,
            &[],
            None,
            0,
        )
        .await
        .unwrap();
        let valid = aqbot_core::repo::message::create_message(
            &db,
            &conversation.id,
            MessageRole::User,
            "safe message",
            &[],
            None,
            0,
        )
        .await
        .unwrap();

        let prepared = materialize_messages_for_ipc(&db, vec![invalid.clone(), valid.clone()])
            .await
            .unwrap();

        assert_eq!(prepared.len(), 2);
        assert_eq!(
            prepared[0].content,
            "[内嵌图片迁移失败，消息原文已保留；请查看诊断记录]"
        );
        assert_eq!(prepared[1].content, "safe message");
        assert_eq!(
            aqbot_core::repo::message::get_message(&db, &invalid.id)
                .await
                .unwrap()
                .content,
            invalid_content
        );
        let diagnostics = aqbot_core::inline_media::list_inline_media_diagnostics(&db, None)
            .await
            .unwrap();
        assert_eq!(diagnostics.len(), 1);
        assert_eq!(diagnostics[0].message_id, invalid.id);
        assert!(!diagnostics[0].error.is_empty());
    }

    #[tokio::test]
    async fn matching_persisted_diagnostic_skips_repeated_ipc_materialization() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let conversation =
            aqbot_core::repo::conversation::create_conversation(&db, "IPC retry", "m1", "p1", None)
                .await
                .unwrap();
        let invalid_content = "![bad](data:image/png;base64,broken!)";
        let invalid = aqbot_core::repo::message::create_message(
            &db,
            &conversation.id,
            MessageRole::Assistant,
            invalid_content,
            &[],
            None,
            0,
        )
        .await
        .unwrap();
        aqbot_core::inline_media::record_inline_media_failure(
            &db,
            &invalid.id,
            invalid_content,
            "persisted diagnostic",
        )
        .await
        .unwrap();

        let prepared = materialize_message_for_ipc(&db, invalid).await.unwrap();

        assert_eq!(prepared.content, INLINE_MEDIA_DIAGNOSTIC_PLACEHOLDER);
        let diagnostics = aqbot_core::inline_media::list_inline_media_diagnostics(&db, None)
            .await
            .unwrap();
        assert_eq!(diagnostics[0].error, "persisted diagnostic");
    }

    #[tokio::test]
    async fn unsafe_attachment_is_diagnosed_without_blocking_the_ipc_batch() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &db,
            "IPC attachment",
            "m1",
            "p1",
            None,
        )
        .await
        .unwrap();
        let unsafe_attachment = Attachment {
            id: "attachment-1".to_string(),
            file_type: "image/png".to_string(),
            file_name: "legacy.png".to_string(),
            file_path: "images/legacy.png".to_string(),
            file_size: 1,
            data: Some("data:image/png;base64,SECRET".to_string()),
        };
        let invalid = aqbot_core::repo::message::create_message(
            &db,
            &conversation.id,
            MessageRole::Assistant,
            "legacy attachment",
            &[unsafe_attachment],
            None,
            0,
        )
        .await
        .unwrap();
        let valid = aqbot_core::repo::message::create_message(
            &db,
            &conversation.id,
            MessageRole::User,
            "safe message",
            &[],
            None,
            0,
        )
        .await
        .unwrap();

        let prepared = materialize_messages_for_ipc(&db, vec![invalid.clone(), valid])
            .await
            .unwrap();

        assert_eq!(prepared.len(), 2);
        assert_eq!(prepared[0].content, INLINE_MEDIA_DIAGNOSTIC_PLACEHOLDER);
        assert!(prepared[0].attachments.is_empty());
        assert_eq!(prepared[1].content, "safe message");
        let stored = aqbot_core::repo::message::get_message(&db, &invalid.id)
            .await
            .unwrap();
        assert_eq!(stored.content, "legacy attachment");
        assert!(stored.attachments[0]
            .data
            .as_deref()
            .unwrap()
            .contains("data:image/png"));
        let diagnostics = aqbot_core::inline_media::list_inline_media_diagnostics(&db, None)
            .await
            .unwrap();
        assert_eq!(diagnostics[0].message_id, invalid.id);
        assert!(diagnostics[0].error.contains("attachments"));
    }
}
