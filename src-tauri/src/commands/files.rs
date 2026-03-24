use crate::AppState;
use aqbot_core::repo::stored_file::StoredFile;
use tauri::State;

#[tauri::command]
pub async fn upload_file(
    state: State<'_, AppState>,
    data: String,
    file_name: String,
    mime_type: String,
    conversation_id: Option<String>,
) -> Result<StoredFile, String> {
    use base64::Engine;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&data)
        .map_err(|e| format!("Invalid base64: {}", e))?;

    aqbot_core::storage_paths::ensure_documents_dirs()
        .map_err(|e| format!("Failed to ensure documents dirs: {}", e))?;
    let file_store = aqbot_core::file_store::FileStore::new();

    let saved = file_store
        .save_file(&bytes, &file_name, &mime_type)
        .map_err(|e| e.to_string())?;

    let id = aqbot_core::utils::gen_id();
    let stored = aqbot_core::repo::stored_file::create_stored_file(
        &state.sea_db,
        &id,
        &saved.hash,
        &file_name,
        &mime_type,
        saved.size_bytes,
        &saved.storage_path,
        conversation_id.as_deref(),
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(stored)
}

#[tauri::command]
pub async fn download_file(
    state: State<'_, AppState>,
    file_id: String,
) -> Result<String, String> {
    use base64::Engine;
    let file = aqbot_core::repo::stored_file::get_stored_file(&state.sea_db, &file_id)
        .await
        .map_err(|e| e.to_string())?;

    let file_store = aqbot_core::file_store::FileStore::new();

    let data = file_store
        .read_file(&file.storage_path)
        .map_err(|e| e.to_string())?;

    Ok(base64::engine::general_purpose::STANDARD.encode(&data))
}

#[tauri::command]
pub async fn list_files(
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<Vec<StoredFile>, String> {
    aqbot_core::repo::stored_file::list_stored_files_by_conversation(
        &state.sea_db,
        &conversation_id,
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_file(
    state: State<'_, AppState>,
    file_id: String,
) -> Result<(), String> {
    let file_store = aqbot_core::file_store::FileStore::new();
    super::file_cleanup::delete_attachment_reference(&state.sea_db, &file_store, &file_id)
        .await
}
