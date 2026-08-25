// Conversation CRUD commands.

#[tauri::command]
pub async fn list_conversations(state: State<'_, AppState>) -> Result<Vec<Conversation>, String> {
    aqbot_core::repo::conversation::list_conversations(&state.sea_db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_conversation_snapshot(
    state: State<'_, AppState>,
    id: String,
) -> Result<Conversation, String> {
    aqbot_core::repo::conversation::get_conversation(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_conversation(
    state: State<'_, AppState>,
    title: String,
    model_id: String,
    provider_id: String,
    system_prompt: Option<String>,
) -> Result<Conversation, String> {
    let real_provider_id = resolve_command_provider_id(&state.sea_db, &provider_id).await?;

    aqbot_core::repo::conversation::create_conversation(
        &state.sea_db,
        &title,
        &model_id,
        &real_provider_id,
        system_prompt.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_conversation(
    state: State<'_, AppState>,
    id: String,
    mut input: UpdateConversationInput,
) -> Result<Conversation, String> {
    if let Some(provider_id) = input.provider_id.as_deref() {
        let real_provider_id = resolve_command_provider_id(&state.sea_db, provider_id).await?;
        input.provider_id = Some(real_provider_id);
    }

    aqbot_core::repo::conversation::update_conversation(&state.sea_db, &id, input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reorder_conversations(
    state: State<'_, AppState>,
    category_id: Option<String>,
    conversation_ids: Vec<String>,
) -> Result<(), String> {
    aqbot_core::repo::conversation::reorder_conversations(
        &state.sea_db,
        category_id.as_deref(),
        &conversation_ids,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_conversation(state: State<'_, AppState>, id: String) -> Result<(), String> {
    delete_conversation_with_attachments(&state.sea_db, &id).await
}

#[tauri::command]
pub async fn branch_conversation(
    state: State<'_, AppState>,
    conversation_id: String,
    until_message_id: String,
    as_child: bool,
    title: Option<String>,
) -> Result<Conversation, String> {
    aqbot_core::repo::conversation::branch_conversation(
        &state.sea_db,
        &conversation_id,
        &until_message_id,
        as_child,
        title.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())
}

async fn delete_conversation_with_attachments(
    db: &sea_orm::DatabaseConnection,
    conversation_id: &str,
) -> Result<(), String> {
    let file_store = aqbot_core::file_store::FileStore::new();
    delete_conversation_with_attachments_using(db, &file_store, conversation_id).await
}

async fn delete_conversation_with_attachments_using(
    db: &sea_orm::DatabaseConnection,
    file_store: &aqbot_core::file_store::FileStore,
    conversation_id: &str,
) -> Result<(), String> {
    let _file_reference_guard = aqbot_core::repo::stored_file::lock_file_references().await;
    let files =
        aqbot_core::repo::stored_file::list_stored_files_by_conversation(db, conversation_id)
            .await
            .map_err(|e| e.to_string())?;
    let candidate_ids = files
        .iter()
        .map(|file| file.id.clone())
        .collect::<HashSet<_>>();
    let txn = db.begin().await.map_err(|error| error.to_string())?;
    let deleted = aqbot_core::entity::conversations::Entity::delete_by_id(conversation_id)
        .exec(&txn)
        .await
        .map_err(|error| error.to_string())?;
    if deleted.rows_affected == 0 {
        return Err(format!("Conversation {conversation_id} not found"));
    }
    let storage_paths =
        aqbot_core::repo::stored_file::delete_unreferenced_candidates(&txn, &candidate_ids)
            .await
            .map_err(|error| error.to_string())?;
    txn.commit().await.map_err(|error| error.to_string())?;

    for storage_path in storage_paths {
        file_store.delete_file(&storage_path).map_err(|error| {
            format!(
                "Conversation was deleted but backing file cleanup failed for {storage_path}: {error}"
            )
        })?;
    }
    Ok(())
}

#[tauri::command]
pub async fn search_conversations(
    state: State<'_, AppState>,
    query: String,
) -> Result<Vec<ConversationSearchResult>, String> {
    aqbot_core::repo::conversation::search_conversations(&state.sea_db, &query)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn toggle_pin_conversation(
    state: State<'_, AppState>,
    id: String,
) -> Result<Conversation, String> {
    aqbot_core::repo::conversation::toggle_pin(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn set_conversation_tab_pinned(
    state: State<'_, AppState>,
    id: String,
    pinned: bool,
) -> Result<Conversation, String> {
    aqbot_core::repo::conversation::set_conversation_tab_pinned(&state.sea_db, &id, pinned)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn toggle_archive_conversation(
    state: State<'_, AppState>,
    id: String,
) -> Result<Conversation, String> {
    aqbot_core::repo::conversation::toggle_archive(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_archived_conversations(
    state: State<'_, AppState>,
) -> Result<Vec<Conversation>, String> {
    aqbot_core::repo::conversation::list_archived_conversations(&state.sea_db)
        .await
        .map_err(|e| e.to_string())
}
