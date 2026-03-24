use crate::AppState;
use aqbot_core::types::*;
use tauri::{AppHandle, Emitter, State};

#[tauri::command]
pub async fn list_knowledge_bases(
    state: State<'_, AppState>,
) -> Result<Vec<KnowledgeBase>, String> {
    aqbot_core::repo::knowledge::list_knowledge_bases(&state.sea_db)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn create_knowledge_base(
    state: State<'_, AppState>,
    input: CreateKnowledgeBaseInput,
) -> Result<KnowledgeBase, String> {
    aqbot_core::repo::knowledge::create_knowledge_base(&state.sea_db, input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_knowledge_base(
    state: State<'_, AppState>,
    id: String,
    input: UpdateKnowledgeBaseInput,
) -> Result<KnowledgeBase, String> {
    aqbot_core::repo::knowledge::update_knowledge_base(&state.sea_db, &id, input)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_knowledge_base(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    aqbot_core::repo::knowledge::delete_knowledge_base(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_knowledge_documents(
    state: State<'_, AppState>,
    base_id: String,
) -> Result<Vec<KnowledgeDocument>, String> {
    aqbot_core::repo::knowledge::list_documents(&state.sea_db, &base_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_knowledge_document(
    app: AppHandle,
    state: State<'_, AppState>,
    base_id: String,
    title: String,
    source_path: String,
    mime_type: String,
) -> Result<KnowledgeDocument, String> {
    let doc = aqbot_core::repo::knowledge::add_document(
        &state.sea_db,
        &base_id,
        &title,
        &source_path,
        &mime_type,
    )
    .await
    .map_err(|e| e.to_string())?;

    // Spawn async indexing task
    let kb = aqbot_core::repo::knowledge::get_knowledge_base(&state.sea_db, &base_id)
        .await
        .map_err(|e| e.to_string())?;

    if let Some(ref embedding_provider) = kb.embedding_provider {
        let db = state.sea_db.clone();
        let master_key = state.master_key;
        let vector_store = state.vector_store.clone();
        let doc_id = doc.id.clone();
        let src_path = source_path.clone();
        let mime = mime_type.clone();
        let ep = embedding_provider.clone();
        let kb_id = base_id.clone();

        tokio::spawn(async move {
            let result = crate::indexing::index_knowledge_document(
                &db,
                &master_key,
                &vector_store,
                &kb_id,
                &doc_id,
                &src_path,
                &mime,
                &ep,
            )
            .await;

            if let Err(e) = &result {
                tracing::error!("Indexing failed for doc {}: {}", doc_id, e);
                let _ = aqbot_core::repo::knowledge::update_document_status(
                    &db, &doc_id, "failed",
                )
                .await;
            }

            // Emit event to notify frontend
            let _ = app.emit(
                "knowledge-document-indexed",
                serde_json::json!({
                    "documentId": doc_id,
                    "success": result.is_ok(),
                    "error": result.err().map(|e| e.to_string()),
                }),
            );
        });
    }

    Ok(doc)
}

#[tauri::command]
pub async fn delete_knowledge_document(
    state: State<'_, AppState>,
    base_id: String,
    id: String,
) -> Result<(), String> {
    // Delete vector embeddings for this document
    let collection_id = format!("kb_{}", base_id);
    let _ = state
        .vector_store
        .delete_document_embeddings(&collection_id, &id)
        .await;

    aqbot_core::repo::knowledge::delete_document(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn search_knowledge_base(
    state: State<'_, AppState>,
    base_id: String,
    query: String,
    top_k: Option<usize>,
) -> Result<Vec<aqbot_core::vector_store::VectorSearchResult>, String> {
    crate::indexing::search_knowledge(
        &state.sea_db,
        &state.master_key,
        &state.vector_store,
        &base_id,
        &query,
        top_k.unwrap_or(5),
    )
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn rebuild_knowledge_index(
    app: AppHandle,
    state: State<'_, AppState>,
    base_id: String,
) -> Result<(), String> {
    let kb = aqbot_core::repo::knowledge::get_knowledge_base(&state.sea_db, &base_id)
        .await
        .map_err(|e| e.to_string())?;

    let embedding_provider = kb
        .embedding_provider
        .ok_or("No embedding provider configured")?;

    // Clear existing collection
    let collection_id = format!("kb_{}", base_id);
    let _ = state.vector_store.delete_collection(&collection_id).await;

    // Get all documents and re-index
    let docs = aqbot_core::repo::knowledge::list_documents(&state.sea_db, &base_id)
        .await
        .map_err(|e| e.to_string())?;

    // Reset all document statuses to "indexing" before spawning
    for doc in &docs {
        let _ = aqbot_core::repo::knowledge::update_document_status(
            &state.sea_db, &doc.id, "indexing",
        ).await;
    }

    let db = state.sea_db.clone();
    let master_key = state.master_key;
    let vector_store = state.vector_store.clone();
    let ep = embedding_provider.clone();

    tokio::spawn(async move {
        for doc in docs {
            let result = crate::indexing::index_knowledge_document(
                &db,
                &master_key,
                &vector_store,
                &base_id,
                &doc.id,
                &doc.source_path,
                &doc.mime_type,
                &ep,
            )
            .await;

            if let Err(e) = &result {
                tracing::error!("Re-indexing failed for doc {}: {}", doc.id, e);
                let _ = aqbot_core::repo::knowledge::update_document_status(
                    &db, &doc.id, "failed",
                )
                .await;
            }
        }

        let _ = app.emit("knowledge-rebuild-complete", serde_json::json!({ "baseId": base_id }));
    });

    Ok(())
}

#[tauri::command]
pub async fn clear_knowledge_index(
    state: State<'_, AppState>,
    base_id: String,
) -> Result<(), String> {
    let collection_id = format!("kb_{}", base_id);
    state
        .vector_store
        .delete_collection(&collection_id)
        .await
        .map_err(|e| e.to_string())?;

    // Reset all documents to "pending"
    let docs = aqbot_core::repo::knowledge::list_documents(&state.sea_db, &base_id)
        .await
        .map_err(|e| e.to_string())?;

    for doc in docs {
        let _ = aqbot_core::repo::knowledge::update_document_status(
            &state.sea_db,
            &doc.id,
            "pending",
        )
        .await;
    }

    Ok(())
}
