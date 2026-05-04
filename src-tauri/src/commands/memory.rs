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
pub async fn delete_memory_namespace(state: State<'_, AppState>, id: String) -> Result<(), String> {
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
        // Set status to indexing
        let _ = aqbot_core::repo::memory::update_item_index_status(
            &state.sea_db,
            &item.id,
            "indexing",
            None,
        )
        .await;

        let db = state.sea_db.clone();
        let master_key = state.master_key;
        let vector_store = state.vector_store.clone();
        let item_id = item.id.clone();
        let content = item.content.clone();
        let ep = embedding_provider.clone();
        let ns_id = item.namespace_id.clone();
        let dims = ns.embedding_dimensions.map(|v| v as usize);

        tokio::spawn(async move {
            let result = crate::indexing::index_memory_item(
                &db,
                &master_key,
                &vector_store,
                &ns_id,
                &item_id,
                &content,
                &ep,
                dims,
            )
            .await;

            let (status, err_msg) = match &result {
                Ok(_) => ("ready", None),
                Err(e) => {
                    tracing::error!("Memory embedding failed for item {}: {}", item_id, e);
                    ("failed", Some(e.to_string()))
                }
            };
            let _ = aqbot_core::repo::memory::update_item_index_status(
                &db,
                &item_id,
                status,
                err_msg.as_deref(),
            )
            .await;

            let _ = app.emit(
                "memory-item-indexed",
                serde_json::json!({
                    "itemId": item_id,
                    "success": result.is_ok(),
                    "status": status,
                    "error": err_msg,
                }),
            );
        });

        // Return item with "indexing" status
        return Ok(MemoryItem {
            index_status: "indexing".to_string(),
            ..item
        });
    } else {
        // No embedding provider — mark as skipped
        let _ = aqbot_core::repo::memory::update_item_index_status(
            &state.sea_db,
            &item.id,
            "skipped",
            None,
        )
        .await;
        return Ok(MemoryItem {
            index_status: "skipped".to_string(),
            ..item
        });
    }
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
pub async fn update_memory_item(
    app: AppHandle,
    state: State<'_, AppState>,
    namespace_id: String,
    id: String,
    input: UpdateMemoryItemInput,
) -> Result<MemoryItem, String> {
    let content_changed = input.content.is_some();
    let item = aqbot_core::repo::memory::update_item(&state.sea_db, &id, input)
        .await
        .map_err(|e| e.to_string())?;

    // Re-index if content changed and namespace has embedding provider
    if content_changed {
        let ns = aqbot_core::repo::memory::get_namespace(&state.sea_db, &namespace_id)
            .await
            .map_err(|e| e.to_string())?;

        if let Some(ref embedding_provider) = ns.embedding_provider {
            // Set status to indexing
            let _ = aqbot_core::repo::memory::update_item_index_status(
                &state.sea_db,
                &id,
                "indexing",
                None,
            )
            .await;

            let db = state.sea_db.clone();
            let master_key = state.master_key;
            let vector_store = state.vector_store.clone();
            let item_id = item.id.clone();
            let content = item.content.clone();
            let ep = embedding_provider.clone();
            let ns_id = namespace_id.clone();
            let dims = ns.embedding_dimensions.map(|v| v as usize);

            tokio::spawn(async move {
                // Delete old embedding first
                let collection_id = format!("mem_{}", ns_id);
                let _ = vector_store
                    .delete_document_embeddings(&collection_id, &item_id)
                    .await;

                let result = crate::indexing::index_memory_item(
                    &db,
                    &master_key,
                    &vector_store,
                    &ns_id,
                    &item_id,
                    &content,
                    &ep,
                    dims,
                )
                .await;

                let (status, err_msg) = match &result {
                    Ok(_) => ("ready", None),
                    Err(e) => {
                        tracing::error!("Memory re-embedding failed for item {}: {}", item_id, e);
                        ("failed", Some(e.to_string()))
                    }
                };
                let _ = aqbot_core::repo::memory::update_item_index_status(
                    &db,
                    &item_id,
                    status,
                    err_msg.as_deref(),
                )
                .await;

                let _ = app.emit(
                    "memory-item-indexed",
                    serde_json::json!({
                        "itemId": item_id,
                        "success": result.is_ok(),
                        "status": status,
                        "error": err_msg,
                    }),
                );
            });

            return Ok(MemoryItem {
                index_status: "indexing".to_string(),
                ..item
            });
        }
    }

    Ok(item)
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

    // Set all items to indexing status
    for item in &items {
        let _ = aqbot_core::repo::memory::update_item_index_status(
            &state.sea_db,
            &item.id,
            "indexing",
            None,
        )
        .await;
    }

    let db = state.sea_db.clone();
    let master_key = state.master_key;
    let vector_store = state.vector_store.clone();
    let ep = embedding_provider.clone();
    let dims = ns.embedding_dimensions.map(|v| v as usize);

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
                dims,
            )
            .await;

            let (status, err_msg) = match &result {
                Ok(_) => ("ready", None),
                Err(e) => {
                    tracing::error!("Memory re-indexing failed for item {}: {}", item.id, e);
                    ("failed", Some(e.to_string()))
                }
            };
            let _ = aqbot_core::repo::memory::update_item_index_status(
                &db,
                &item.id,
                status,
                err_msg.as_deref(),
            )
            .await;

            // Emit per-item event for real-time progress
            let _ = app.emit(
                "memory-item-indexed",
                serde_json::json!({
                    "itemId": item.id,
                    "success": result.is_ok(),
                    "status": status,
                    "error": err_msg,
                    "isRebuild": true,
                }),
            );
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
        .map_err(|e| e.to_string())?;

    // Reset all items to "pending"
    let items = aqbot_core::repo::memory::list_items(&state.sea_db, &namespace_id)
        .await
        .map_err(|e| e.to_string())?;

    for item in items {
        let _ = aqbot_core::repo::memory::update_item_index_status(
            &state.sea_db,
            &item.id,
            "pending",
            None,
        )
        .await;
    }

    Ok(())
}

#[tauri::command]
pub async fn reindex_memory_item(
    app: AppHandle,
    state: State<'_, AppState>,
    namespace_id: String,
    item_id: String,
) -> Result<(), String> {
    let ns = aqbot_core::repo::memory::get_namespace(&state.sea_db, &namespace_id)
        .await
        .map_err(|e| e.to_string())?;

    let embedding_provider = ns
        .embedding_provider
        .ok_or("No embedding provider configured")?;

    let items = aqbot_core::repo::memory::list_items(&state.sea_db, &namespace_id)
        .await
        .map_err(|e| e.to_string())?;

    let item = items
        .into_iter()
        .find(|i| i.id == item_id)
        .ok_or("Item not found")?;

    let _ = aqbot_core::repo::memory::update_item_index_status(
        &state.sea_db,
        &item_id,
        "indexing",
        None,
    )
    .await;

    let db = state.sea_db.clone();
    let master_key = state.master_key;
    let vector_store = state.vector_store.clone();
    let ep = embedding_provider.clone();
    let ns_id = namespace_id.clone();
    let iid = item_id.clone();
    let content = item.content.clone();
    let dims = ns.embedding_dimensions.map(|v| v as usize);

    tokio::spawn(async move {
        let collection_id = format!("mem_{}", ns_id);
        let _ = vector_store
            .delete_document_embeddings(&collection_id, &iid)
            .await;

        let result = crate::indexing::index_memory_item(
            &db,
            &master_key,
            &vector_store,
            &ns_id,
            &iid,
            &content,
            &ep,
            dims,
        )
        .await;

        let (status, err_msg) = match &result {
            Ok(_) => ("ready", None),
            Err(e) => {
                tracing::error!("Memory reindex failed for item {}: {}", iid, e);
                ("failed", Some(e.to_string()))
            }
        };
        let _ = aqbot_core::repo::memory::update_item_index_status(
            &db,
            &iid,
            status,
            err_msg.as_deref(),
        )
        .await;

        let _ = app.emit(
            "memory-item-indexed",
            serde_json::json!({
                "itemId": iid,
                "success": result.is_ok(),
                "status": status,
                "error": err_msg,
            }),
        );
    });

    Ok(())
}

#[tauri::command]
pub async fn reorder_memory_namespaces(
    state: State<'_, AppState>,
    namespace_ids: Vec<String>,
) -> Result<(), String> {
    aqbot_core::repo::memory::reorder_namespaces(&state.sea_db, &namespace_ids)
        .await
        .map_err(|e| e.to_string())
}
