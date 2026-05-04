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
pub async fn delete_knowledge_base(state: State<'_, AppState>, id: String) -> Result<(), String> {
    aqbot_core::repo::knowledge::delete_knowledge_base(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn reorder_knowledge_bases(
    state: State<'_, AppState>,
    base_ids: Vec<String>,
) -> Result<(), String> {
    aqbot_core::repo::knowledge::reorder_knowledge_bases(&state.sea_db, &base_ids)
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
        None, // doc_type defaults to "file"
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
        let chunk_sz = kb.chunk_size;
        let chunk_ov = kb.chunk_overlap;
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
                chunk_sz,
                chunk_ov,
            )
            .await;

            if let Err(e) = &result {
                let err_msg = e.to_string();
                tracing::error!("Indexing failed for doc {}: {}", doc_id, err_msg);
                let _ = aqbot_core::repo::knowledge::update_document_status_with_error(
                    &db,
                    &doc_id,
                    "failed",
                    Some(&err_msg),
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

    let collection_id = format!("kb_{}", base_id);

    // Get all documents
    let docs = aqbot_core::repo::knowledge::list_documents(&state.sea_db, &base_id)
        .await
        .map_err(|e| e.to_string())?;

    if docs.is_empty() {
        let _ = app.emit(
            "knowledge-rebuild-complete",
            serde_json::json!({ "baseId": base_id }),
        );
        return Ok(());
    }

    // Reset all document statuses to "indexing"
    for doc in &docs {
        let _ =
            aqbot_core::repo::knowledge::update_document_status(&state.sea_db, &doc.id, "indexing")
                .await;
    }

    // Clear only embeddings (vec0), keep _meta intact
    let _ = state.vector_store.clear_embeddings(&collection_id).await;

    let db = state.sea_db.clone();
    let master_key = state.master_key;
    let vector_store = state.vector_store.clone();
    let ep = embedding_provider.clone();

    tokio::spawn(async move {
        // Process each document individually so status updates per-doc
        for doc in &docs {
            let chunks = match vector_store
                .list_document_chunks_raw(&collection_id, &doc.id)
                .await
            {
                Ok(c) => c,
                Err(e) => {
                    let err_msg = e.to_string();
                    let _ = aqbot_core::repo::knowledge::update_document_status_with_error(
                        &db,
                        &doc.id,
                        "failed",
                        Some(&err_msg),
                    )
                    .await;
                    let _ = app.emit(
                        "knowledge-document-indexed",
                        serde_json::json!({
                            "documentId": doc.id,
                            "success": false,
                            "error": err_msg,
                        }),
                    );
                    continue;
                }
            };

            if chunks.is_empty() {
                let _ = aqbot_core::repo::knowledge::update_document_status_with_error(
                    &db, &doc.id, "ready", None,
                )
                .await;
                let _ = app.emit(
                    "knowledge-document-indexed",
                    serde_json::json!({ "documentId": doc.id, "success": true }),
                );
                continue;
            }

            let texts: Vec<String> = chunks
                .iter()
                .map(|(_, _, content)| content.clone())
                .collect();
            let rowids: Vec<i64> = chunks.iter().map(|(rid, _, _)| *rid).collect();

            match crate::indexing::generate_embeddings(&db, &master_key, &ep, texts, None).await {
                Ok(embed_response) => {
                    let entries: Vec<(i64, Vec<f32>)> = rowids
                        .into_iter()
                        .zip(embed_response.embeddings.into_iter())
                        .collect();

                    if let Err(e) = vector_store
                        .upsert_document_embeddings(&collection_id, entries)
                        .await
                    {
                        let err_msg = e.to_string();
                        tracing::error!(
                            "Failed to upsert embeddings for doc {}: {}",
                            doc.id,
                            err_msg
                        );
                        let _ = aqbot_core::repo::knowledge::update_document_status_with_error(
                            &db,
                            &doc.id,
                            "failed",
                            Some(&err_msg),
                        )
                        .await;
                        let _ = app.emit(
                            "knowledge-document-indexed",
                            serde_json::json!({
                                "documentId": doc.id,
                                "success": false,
                                "error": err_msg,
                            }),
                        );
                    } else {
                        let _ = aqbot_core::repo::knowledge::update_document_status_with_error(
                            &db, &doc.id, "ready", None,
                        )
                        .await;
                        let _ = app.emit(
                            "knowledge-document-indexed",
                            serde_json::json!({
                                "documentId": doc.id,
                                "success": true,
                            }),
                        );
                    }
                }
                Err(e) => {
                    let err_msg = e.to_string();
                    tracing::error!("Failed to embed doc {} during rebuild: {}", doc.id, err_msg);
                    let _ = aqbot_core::repo::knowledge::update_document_status_with_error(
                        &db,
                        &doc.id,
                        "failed",
                        Some(&err_msg),
                    )
                    .await;
                    let _ = app.emit(
                        "knowledge-document-indexed",
                        serde_json::json!({
                            "documentId": doc.id,
                            "success": false,
                            "error": err_msg,
                        }),
                    );
                }
            }
        }

        let _ = app.emit(
            "knowledge-rebuild-complete",
            serde_json::json!({ "baseId": base_id }),
        );
    });

    Ok(())
}

#[tauri::command]
pub async fn clear_knowledge_index(
    state: State<'_, AppState>,
    base_id: String,
) -> Result<(), String> {
    let collection_id = format!("kb_{}", base_id);
    // Only clear embeddings (vec0), keep chunk metadata (_meta) intact
    state
        .vector_store
        .clear_embeddings(&collection_id)
        .await
        .map_err(|e| e.to_string())?;

    // Reset all documents to "pending"
    let docs = aqbot_core::repo::knowledge::list_documents(&state.sea_db, &base_id)
        .await
        .map_err(|e| e.to_string())?;

    for doc in docs {
        let _ =
            aqbot_core::repo::knowledge::update_document_status(&state.sea_db, &doc.id, "pending")
                .await;
    }

    Ok(())
}

#[tauri::command]
pub async fn list_knowledge_document_chunks(
    state: State<'_, AppState>,
    base_id: String,
    document_id: String,
) -> Result<Vec<aqbot_core::vector_store::VectorSearchResult>, String> {
    let collection_id = format!("kb_{}", base_id);
    state
        .vector_store
        .list_document_chunks(&collection_id, &document_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn delete_knowledge_chunk(
    state: State<'_, AppState>,
    base_id: String,
    chunk_id: String,
) -> Result<(), String> {
    let collection_id = format!("kb_{}", base_id);
    state
        .vector_store
        .delete_chunk(&collection_id, &chunk_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn update_knowledge_chunk(
    state: State<'_, AppState>,
    base_id: String,
    chunk_id: String,
    content: String,
) -> Result<(), String> {
    let collection_id = format!("kb_{}", base_id);
    state
        .vector_store
        .update_chunk_content(&collection_id, &chunk_id, &content)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn add_knowledge_chunk(
    app: AppHandle,
    state: State<'_, AppState>,
    base_id: String,
    document_id: String,
    content: String,
) -> Result<String, String> {
    let kb = aqbot_core::repo::knowledge::get_knowledge_base(&state.sea_db, &base_id)
        .await
        .map_err(|e| e.to_string())?;

    let embedding_provider = kb
        .embedding_provider
        .ok_or_else(|| "No embedding provider configured".to_string())?;

    let collection_id = format!("kb_{}", base_id);
    let db = state.sea_db.clone();
    let master_key = state.master_key;
    let vector_store = state.vector_store.clone();
    let doc_id = document_id.clone();
    let chunk_content = content.clone();

    let chunk_id_result = tokio::spawn(async move {
        let embed_response = crate::indexing::generate_embeddings(
            &db,
            &master_key,
            &embedding_provider,
            vec![chunk_content.clone()],
            None,
        )
        .await?;

        let embedding = embed_response
            .embeddings
            .into_iter()
            .next()
            .ok_or_else(|| {
                aqbot_core::error::AQBotError::Provider("No embedding returned".to_string())
            })?;

        let chunk_id = vector_store
            .add_single_chunk(&collection_id, &doc_id, &chunk_content, &embedding)
            .await?;

        let _ = app.emit(
            "knowledge-chunk-added",
            serde_json::json!({
                "baseId": base_id,
                "documentId": doc_id,
                "chunkId": chunk_id,
            }),
        );

        Ok::<String, aqbot_core::error::AQBotError>(chunk_id)
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())?;

    Ok(chunk_id_result)
}

#[tauri::command]
pub async fn reindex_knowledge_chunk(
    app: AppHandle,
    state: State<'_, AppState>,
    base_id: String,
    chunk_id: String,
) -> Result<(), String> {
    let kb = aqbot_core::repo::knowledge::get_knowledge_base(&state.sea_db, &base_id)
        .await
        .map_err(|e| e.to_string())?;

    let embedding_provider = kb
        .embedding_provider
        .ok_or_else(|| "No embedding provider configured".to_string())?;

    let collection_id = format!("kb_{}", base_id);

    let chunk_content = {
        use sea_orm::{ConnectionTrait, DbBackend, Statement};
        let name = format!("vec_kb_{}", base_id.replace('-', "_"));
        let row = state
            .sea_db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                &format!("SELECT content FROM {name}_meta WHERE id = $1"),
                vec![chunk_id.clone().into()],
            ))
            .await
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("Chunk {} not found", chunk_id))?;
        row.try_get::<String>("", "content")
            .map_err(|e| e.to_string())?
    };

    // Embed the single chunk
    let db = state.sea_db.clone();
    let master_key = state.master_key;
    let vector_store = state.vector_store.clone();
    let cid = chunk_id.clone();

    tokio::spawn(async move {
        let result = async {
            let embed_response = crate::indexing::generate_embeddings(
                &db,
                &master_key,
                &embedding_provider,
                vec![chunk_content],
                None,
            )
            .await?;

            if let Some(embedding) = embed_response.embeddings.into_iter().next() {
                vector_store
                    .update_chunk_embedding(&collection_id, &cid, &embedding)
                    .await?;
            }
            Ok::<_, aqbot_core::error::AQBotError>(())
        }
        .await;

        let _ = app.emit(
            "knowledge-chunk-reindexed",
            serde_json::json!({
                "chunkId": cid,
                "success": result.is_ok(),
                "error": result.err().map(|e| e.to_string()),
            }),
        );
    });

    Ok(())
}

/// Rebuild the index for a single document (re-embed its chunks only).
#[tauri::command]
pub async fn rebuild_knowledge_document(
    app: AppHandle,
    state: State<'_, AppState>,
    base_id: String,
    document_id: String,
) -> Result<(), String> {
    let kb = aqbot_core::repo::knowledge::get_knowledge_base(&state.sea_db, &base_id)
        .await
        .map_err(|e| e.to_string())?;

    let embedding_provider = kb
        .embedding_provider
        .ok_or("No embedding provider configured")?;

    let collection_id = format!("kb_{}", base_id);

    let chunks = state
        .vector_store
        .list_document_chunks_raw(&collection_id, &document_id)
        .await
        .map_err(|e| e.to_string())?;

    if chunks.is_empty() {
        let _ = app.emit(
            "knowledge-document-indexed",
            serde_json::json!({ "documentId": document_id, "success": true }),
        );
        return Ok(());
    }

    // Set document status to "indexing"
    let _ = aqbot_core::repo::knowledge::update_document_status(
        &state.sea_db,
        &document_id,
        "indexing",
    )
    .await;

    let db = state.sea_db.clone();
    let master_key = state.master_key;
    let vector_store = state.vector_store.clone();
    let ep = embedding_provider.clone();
    let doc_id = document_id.clone();

    tokio::spawn(async move {
        let texts: Vec<String> = chunks
            .iter()
            .map(|(_, _, content)| content.clone())
            .collect();
        let rowids: Vec<i64> = chunks.iter().map(|(rid, _, _)| *rid).collect();

        let result = crate::indexing::generate_embeddings(&db, &master_key, &ep, texts, None).await;

        match result {
            Ok(embed_response) => {
                let entries: Vec<(i64, Vec<f32>)> = rowids
                    .into_iter()
                    .zip(embed_response.embeddings.into_iter())
                    .collect();

                if let Err(e) = vector_store
                    .upsert_document_embeddings(&collection_id, entries)
                    .await
                {
                    let err_msg = e.to_string();
                    tracing::error!(
                        "Failed to upsert embeddings for doc {}: {}",
                        doc_id,
                        err_msg
                    );
                    let _ = aqbot_core::repo::knowledge::update_document_status_with_error(
                        &db,
                        &doc_id,
                        "failed",
                        Some(&err_msg),
                    )
                    .await;
                    let _ = app.emit(
                        "knowledge-document-indexed",
                        serde_json::json!({
                            "documentId": doc_id,
                            "success": false,
                            "error": err_msg,
                        }),
                    );
                } else {
                    let _ = aqbot_core::repo::knowledge::update_document_status_with_error(
                        &db, &doc_id, "ready", None,
                    )
                    .await;
                    let _ = app.emit(
                        "knowledge-document-indexed",
                        serde_json::json!({
                            "documentId": doc_id,
                            "success": true,
                        }),
                    );
                }
            }
            Err(e) => {
                let err_msg = e.to_string();
                tracing::error!("Failed to embed doc {}: {}", doc_id, err_msg);
                let _ = aqbot_core::repo::knowledge::update_document_status_with_error(
                    &db,
                    &doc_id,
                    "failed",
                    Some(&err_msg),
                )
                .await;
                let _ = app.emit(
                    "knowledge-document-indexed",
                    serde_json::json!({
                        "documentId": doc_id,
                        "success": false,
                        "error": err_msg,
                    }),
                );
            }
        }
    });

    Ok(())
}
