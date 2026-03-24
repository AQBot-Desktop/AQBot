use crate::AppState;
use aqbot_core::types::*;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn list_memory_namespaces(
    state: State<'_, AppState>,
) -> Result<Vec<MemoryNamespace>, String> {
    aqbot_core::repo::memory::list_namespaces(&state.sea_db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_memory_namespace(
    state: State<'_, AppState>,
    input: CreateMemoryNamespaceInput,
) -> Result<MemoryNamespace, String> {
    aqbot_core::repo::memory::create_namespace(&state.sea_db, input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_memory_namespace(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    aqbot_core::repo::memory::delete_namespace(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_memory_namespace(
    state: State<'_, AppState>,
    id: String,
    input: UpdateMemoryNamespaceInput,
) -> Result<MemoryNamespace, String> {
    aqbot_core::repo::memory::update_namespace(&state.sea_db, &id, input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_memory_items(
    state: State<'_, AppState>,
    namespace_id: String,
) -> Result<Vec<MemoryItem>, String> {
    aqbot_core::repo::memory::list_items(&state.sea_db, &namespace_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_memory_item(
    app: AppHandle,
    state: State<'_, AppState>,
    input: CreateMemoryItemInput,
) -> Result<MemoryItem, String> {
    let item = aqbot_core::repo::memory::add_item(&state.sea_db, input)
        .await
        .map_err(|e| e.to_string())?;

    // Spawn async embedding task if namespace has an embedding provider
    let ns = aqbot_core::repo::memory::get_namespace(&state.sea_db, &item.namespace_id)
        .await
        .map_err(|e| e.to_string())?;

    if let Some(ref embedding_provider) = ns.embedding_provider {
        let db = state.sea_db.clone();
        let master_key = state.master_key;
        let vector_store = state.vector_store.clone();
        let item_id = item.id.clone();
        let content = item.content.clone();
        let ep = embedding_provider.clone();
        let ns_id = item.namespace_id.clone();

        tokio::spawn(async move {
            let result = crate::indexing::index_memory_item(
                &db,
                &master_key,
                &vector_store,
                &ns_id,
                &item_id,
                &content,
                &ep,
            )
            .await;

            if let Err(e) = &result {
                tracing::error!("Memory embedding failed for item {}: {}", item_id, e);
            }

            let _ = app.emit(
                "memory-item-indexed",
                serde_json::json!({
                    "itemId": item_id,
                    "success": result.is_ok(),
                    "error": result.err().map(|e| e.to_string()),
                }),
            );
        });
    }

    Ok(item)
}

#[tauri::command]
pub async fn delete_memory_item(
    state: State<'_, AppState>,
    namespace_id: String,
    id: String,
) -> Result<(), String> {
    // Delete vector embedding for this item
    let collection_id = format!("mem_{}", namespace_id);
    let _ = state
        .vector_store
        .delete_document_embeddings(&collection_id, &id)
        .await;

    aqbot_core::repo::memory::delete_item(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn search_memory(
    state: State<'_, AppState>,
    namespace_id: String,
    query: String,
    top_k: Option<usize>,
) -> Result<Vec<aqbot_core::vector_store::VectorSearchResult>, String> {
    crate::indexing::search_memory(
        &state.sea_db,
        &state.master_key,
        &state.vector_store,
        &namespace_id,
        &query,
        top_k.unwrap_or(5),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rebuild_memory_index(
    app: AppHandle,
    state: State<'_, AppState>,
    namespace_id: String,
) -> Result<(), String> {
    let ns = aqbot_core::repo::memory::get_namespace(&state.sea_db, &namespace_id)
        .await
        .map_err(|e| e.to_string())?;

    let embedding_provider = ns
        .embedding_provider
        .ok_or("No embedding provider configured")?;

    // Clear existing collection
    let collection_id = format!("mem_{}", namespace_id);
    let _ = state.vector_store.delete_collection(&collection_id).await;

    // Get all items and re-index
    let items = aqbot_core::repo::memory::list_items(&state.sea_db, &namespace_id)
        .await
        .map_err(|e| e.to_string())?;

    let db = state.sea_db.clone();
    let master_key = state.master_key;
    let vector_store = state.vector_store.clone();
    let ep = embedding_provider.clone();

    tokio::spawn(async move {
        for item in items {
            let result = crate::indexing::index_memory_item(
                &db,
                &master_key,
                &vector_store,
                &namespace_id,
                &item.id,
                &item.content,
                &ep,
            )
            .await;

            if let Err(e) = &result {
                tracing::error!("Memory re-indexing failed for item {}: {}", item.id, e);
            }
        }

        let _ = app.emit(
            "memory-rebuild-complete",
            serde_json::json!({ "namespaceId": namespace_id }),
        );
    });

    Ok(())
}

#[tauri::command]
pub async fn clear_memory_index(
    state: State<'_, AppState>,
    namespace_id: String,
) -> Result<(), String> {
    let collection_id = format!("mem_{}", namespace_id);
    state
        .vector_store
        .delete_collection(&collection_id)
        .await
        .map_err(|e| e.to_string())
}
