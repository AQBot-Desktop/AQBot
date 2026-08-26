// Message attachment persistence and rollback helpers.

pub(crate) async fn persist_attachments(
    state: &AppState,
    conversation_id: &str,
    attachments: &[AttachmentInput],
) -> aqbot_core::error::Result<Vec<Attachment>> {
    aqbot_core::attachment_persistence::persist_attachments(
        &state.sea_db,
        Some(conversation_id),
        attachments,
    )
    .await
}

pub(crate) async fn cleanup_new_message_attachments(
    db: &DatabaseConnection,
    attachments: &[Attachment],
) -> Vec<String> {
    let file_store = aqbot_core::file_store::FileStore::new();
    let mut ids = attachments
        .iter()
        .map(|attachment| attachment.id.as_str())
        .filter(|id| !id.is_empty())
        .collect::<Vec<_>>();
    ids.sort_unstable();
    ids.dedup();
    let mut errors = Vec::new();
    for id in ids {
        if let Err(error) =
            crate::commands::file_cleanup::delete_attachment_reference(db, &file_store, id).await
        {
            errors.push(format!("failed to clean attachment {id}: {error}"));
        }
    }
    errors
}

pub(crate) async fn rollback_new_message(
    db: &DatabaseConnection,
    message_id: &str,
    attachments: &[Attachment],
) -> Vec<String> {
    if let Err(error) = aqbot_core::repo::message::delete_message(db, message_id).await {
        return vec![format!(
            "failed to remove message {message_id}; attachments were retained: {error}"
        )];
    }
    cleanup_new_message_attachments(db, attachments).await
}

async fn rollback_counted_new_message(
    db: &DatabaseConnection,
    conversation_id: &str,
    message_id: &str,
    attachments: &[Attachment],
) -> Vec<String> {
    if let Err(error) = aqbot_core::repo::message::delete_message(db, message_id).await {
        return vec![format!(
            "failed to remove message {message_id}; count and attachments were retained: {error}"
        )];
    }

    let mut errors = Vec::new();
    if let Err(error) =
        aqbot_core::repo::conversation::decrement_message_count(db, conversation_id).await
    {
        errors.push(format!(
            "failed to restore conversation message count: {error}"
        ));
    }
    errors.extend(cleanup_new_message_attachments(db, attachments).await);
    errors
}

pub(crate) fn format_new_message_failure(
    message_id: &str,
    stage: &str,
    primary: impl std::fmt::Display,
    rollback_errors: Vec<String>,
) -> String {
    let rollback = if rollback_errors.is_empty() {
        "none".to_string()
    } else {
        rollback_errors.join(", ")
    };
    format!("Message {message_id} {stage}: {primary}; rollback errors: {rollback}")
}

pub(crate) async fn persist_user_message_turn(
    state: &AppState,
    conversation_id: &str,
    content: &str,
    attachments: Vec<AttachmentInput>,
) -> Result<Message, String> {
    let prepared_inline_media = aqbot_core::inline_media::prepare_message_inline_images(content)
        .map_err(|error| format!("Message content rejected before persistence: {error}"))?;
    let persisted_attachments = persist_attachments(state, conversation_id, &attachments)
        .await
        .map_err(|e| e.to_string())?;
    let safe_content = prepared_inline_media
        .as_ref()
        .map(|prepared| prepared.safe_content())
        .unwrap_or(content);
    let user_message = match aqbot_core::repo::message::create_message(
        &state.sea_db,
        conversation_id,
        MessageRole::User,
        safe_content,
        &persisted_attachments,
        None,
        0,
    )
    .await
    {
        Ok(message) => message,
        Err(error) => {
            let cleanup_errors =
                cleanup_new_message_attachments(&state.sea_db, &persisted_attachments).await;
            return Err(format!(
                "Message creation failed: {error}; attachment rollback errors: {}",
                if cleanup_errors.is_empty() {
                    "none".to_string()
                } else {
                    cleanup_errors.join(", ")
                }
            ));
        }
    };
    let user_message =
        finalize_new_message_for_ipc(&state.sea_db, user_message, prepared_inline_media.as_ref())
            .await?;
    if let Err(error) =
        aqbot_core::repo::conversation::increment_message_count(&state.sea_db, conversation_id).await
    {
        let rollback_errors =
            rollback_new_message(&state.sea_db, &user_message.id, &user_message.attachments).await;
        return Err(format_new_message_failure(
            &user_message.id,
            "message-count update failed",
            error,
            rollback_errors,
        ));
    }
    Ok(user_message)
}

async fn finalize_new_message_for_ipc(
    db: &DatabaseConnection,
    message: Message,
    prepared: Option<&aqbot_core::inline_media::PreparedInlineMedia>,
) -> Result<Message, String> {
    let message_id = message.id.clone();
    let mut rollback_attachments = message.attachments.clone();
    let finalized = match prepared {
        Some(prepared) => {
            let file_store = aqbot_core::file_store::FileStore::new();
            match aqbot_core::inline_media::materialize_prepared_message_inline_images(
                db,
                &file_store,
                &message_id,
                prepared,
            )
            .await
            {
                Ok(message) => message,
                Err(error) => {
                    let rollback_errors =
                        rollback_new_message(db, &message_id, &rollback_attachments).await;
                    return Err(format_new_message_failure(
                        &message_id,
                        "inline media persistence failed",
                        error,
                        rollback_errors,
                    ));
                }
            }
        }
        None => message,
    };
    rollback_attachments = finalized.attachments.clone();
    if let Err(error) = crate::commands::messages::ensure_message_safe_for_ipc(&finalized) {
        let rollback_errors = rollback_new_message(db, &message_id, &rollback_attachments).await;
        return Err(format_new_message_failure(
            &message_id,
            "IPC validation failed",
            error,
            rollback_errors,
        ));
    }
    Ok(finalized)
}
