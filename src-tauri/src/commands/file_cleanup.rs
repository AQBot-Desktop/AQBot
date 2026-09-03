use sea_orm::{
    ColumnTrait, DatabaseConnection, EntityTrait, PaginatorTrait, QueryFilter, TransactionTrait,
};
use std::collections::HashSet;

pub async fn delete_attachment_reference(
    db: &DatabaseConnection,
    file_store: &aqbot_core::file_store::FileStore,
    record_id: &str,
) -> Result<(), String> {
    let _guard = aqbot_core::repo::stored_file::lock_file_references().await;
    delete_attachment_reference_locked(db, file_store, record_id).await
}

pub async fn delete_attachment_reference_locked(
    db: &DatabaseConnection,
    file_store: &aqbot_core::file_store::FileStore,
    record_id: &str,
) -> Result<(), String> {
    let txn = db.begin().await.map_err(|e| e.to_string())?;
    let operation = async {
        if aqbot_core::repo::tray_icon::file_id(&txn).await?.as_deref() == Some(record_id) {
            return Err(aqbot_core::error::AQBotError::Validation("tray_icon_in_use".into()));
        }
        aqbot_core::entity::stored_files::Entity::find_by_id(record_id)
            .one(&txn)
            .await?
            .ok_or_else(|| {
                aqbot_core::error::AQBotError::NotFound(format!("StoredFile {record_id}"))
            })?;
        let candidates = HashSet::from([record_id.to_string()]);
        let storage_paths =
            aqbot_core::repo::stored_file::delete_unreferenced_candidates(&txn, &candidates)
                .await?;
        if aqbot_core::entity::stored_files::Entity::find_by_id(record_id)
            .one(&txn)
            .await?
            .is_some()
        {
            return Err(aqbot_core::error::AQBotError::Validation(format!(
                "Stored file {record_id} is still referenced by a message, ACP message, or Drawing resource"
            )));
        }
        Ok::<_, aqbot_core::error::AQBotError>(storage_paths)
    }
    .await;
    let storage_paths = match operation {
        Ok(result) => result,
        Err(error) => {
            let rollback = txn.rollback().await.err();
            return Err(format!(
                "Failed to remove stored file reference {record_id}: {error}; rollback error: {}",
                rollback
                    .map(|error| error.to_string())
                    .unwrap_or_else(|| "none".to_string())
            ));
        }
    };
    txn.commit().await.map_err(|error| {
        format!("Failed to commit removal of stored file reference {record_id}: {error}")
    })?;
    for storage_path in storage_paths {
        file_store.delete_file(&storage_path).map_err(|e| {
            format!(
                "Stored file reference {record_id} was removed, but backing file cleanup failed for {storage_path}: {e}"
            )
        })?;
    }

    Ok(())
}

/// Force-delete a `stored_files` row even when messages or Drawing still reference it.
///
/// Used by the Files page to purge **missing** index entries. Chat/Drawing may keep
/// dead media IDs (already broken when the backing file is gone). Unlike
/// [`delete_attachment_reference`], this does not require the file to be unreferenced.
pub async fn force_delete_stored_file_record(
    db: &DatabaseConnection,
    file_store: &aqbot_core::file_store::FileStore,
    record_id: &str,
) -> Result<(), String> {
    let _guard = aqbot_core::repo::stored_file::lock_file_references().await;
    force_delete_stored_file_record_locked(db, file_store, record_id).await
}

async fn force_delete_stored_file_record_locked(
    db: &DatabaseConnection,
    file_store: &aqbot_core::file_store::FileStore,
    record_id: &str,
) -> Result<(), String> {
    let txn = db.begin().await.map_err(|e| e.to_string())?;
    let operation = async {
        if aqbot_core::repo::stored_file::is_referenced_by_acp(&txn, record_id).await? {
            return Err(aqbot_core::error::AQBotError::Validation(format!(
                "Stored file {record_id} is still referenced by an ACP message"
            )));
        }
        if aqbot_core::repo::tray_icon::file_id(&txn).await?.as_deref() == Some(record_id) {
            return Err(aqbot_core::error::AQBotError::Validation(
                "tray_icon_in_use".to_string(),
            ));
        }
        let file = aqbot_core::entity::stored_files::Entity::find_by_id(record_id)
            .one(&txn)
            .await?
            .ok_or_else(|| {
                aqbot_core::error::AQBotError::NotFound(format!("StoredFile {record_id}"))
            })?;
        let storage_path = file.storage_path.clone();
        aqbot_core::entity::stored_files::Entity::delete_by_id(record_id)
            .exec(&txn)
            .await?;
        let remaining = aqbot_core::entity::stored_files::Entity::find()
            .filter(aqbot_core::entity::stored_files::Column::StoragePath.eq(&storage_path))
            .count(&txn)
            .await?;
        let paths = if remaining == 0 {
            vec![storage_path]
        } else {
            Vec::new()
        };
        Ok::<_, aqbot_core::error::AQBotError>(paths)
    }
    .await;
    let storage_paths = match operation {
        Ok(result) => result,
        Err(error) => {
            let rollback = txn.rollback().await.err();
            return Err(format!(
                "Failed to force-remove stored file record {record_id}: {error}; rollback error: {}",
                rollback
                    .map(|error| error.to_string())
                    .unwrap_or_else(|| "none".to_string())
            ));
        }
    };
    txn.commit().await.map_err(|error| {
        format!("Failed to commit force-removal of stored file record {record_id}: {error}")
    })?;
    for storage_path in storage_paths {
        file_store.delete_file(&storage_path).map_err(|e| {
            format!(
                "Stored file record {record_id} was removed, but backing file cleanup failed for {storage_path}: {e}"
            )
        })?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use sea_orm::ActiveModelTrait;
    use sea_orm::Set;

    #[tokio::test]
    async fn tray_icon_is_protected_from_normal_and_missing_file_deletion() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let root = tempfile::tempdir().unwrap();
        let store = aqbot_core::file_store::FileStore::with_root(root.path().into());
        let saved = store.save_file(b"icon", "tray.png", "image/png").unwrap();
        {
            let _guard = aqbot_core::repo::stored_file::lock_file_references().await;
            aqbot_core::repo::tray_icon::commit_change(&db, Some(aqbot_core::repo::tray_icon::NewIcon {
                id: "tray", saved: &saved, name: "tray.png",
            }), || Ok(())).await.unwrap();
        }
        assert!(delete_attachment_reference(&db, &store, "tray").await.unwrap_err().contains("tray_icon_in_use"));
        store.delete_file(&saved.storage_path).unwrap();
        assert!(force_delete_stored_file_record(&db, &store, "tray").await.unwrap_err().contains("tray_icon_in_use"));
        assert_eq!(aqbot_core::repo::tray_icon::file_id(&db).await.unwrap().as_deref(), Some("tray"));
        assert!(aqbot_core::repo::stored_file::get_stored_file(&db, "tray").await.is_ok());
    }

    #[tokio::test]
    async fn refuses_to_delete_a_file_that_is_still_referenced_by_chat() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let root = tempfile::tempdir().unwrap();
        let file_store = aqbot_core::file_store::FileStore::with_root(root.path().to_path_buf());
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &db,
            "Referenced file",
            "model",
            "provider",
            None,
        )
        .await
        .unwrap();
        let saved = file_store
            .save_file(b"referenced", "referenced.png", "image/png")
            .unwrap();
        let stored = aqbot_core::repo::stored_file::create_stored_file(
            &db,
            "referenced-file",
            &saved.hash,
            "referenced.png",
            "image/png",
            saved.size_bytes,
            &saved.storage_path,
            Some(&conversation.id),
        )
        .await
        .unwrap();
        aqbot_core::repo::message::create_message(
            &db,
            &conversation.id,
            aqbot_core::types::MessageRole::User,
            &format!("![attachment](aqbot-media://stored/{})", stored.id),
            &[],
            None,
            0,
        )
        .await
        .unwrap();

        let error = delete_attachment_reference(&db, &file_store, &stored.id)
            .await
            .unwrap_err();

        assert!(error.contains("still referenced"));
        assert!(
            aqbot_core::repo::stored_file::get_stored_file(&db, &stored.id)
                .await
                .is_ok()
        );
        assert!(file_store.resolve_path(&saved.storage_path).exists());
    }

    #[tokio::test]
    async fn refuses_to_delete_a_file_that_is_still_referenced_by_acp() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let root = tempfile::tempdir().unwrap();
        let file_store = aqbot_core::file_store::FileStore::with_root(root.path().to_path_buf());
        let project = aqbot_core::repo::acp::create_project(&db, "ACP files", "/tmp")
            .await
            .unwrap();
        let thread = aqbot_core::repo::acp::create_thread(
            &db,
            &project.id,
            "test-agent",
            "Referenced ACP file",
        )
        .await
        .unwrap();
        let saved = file_store
            .save_file(b"acp-reference", "workspace.tar", "application/x-tar")
            .unwrap();
        let stored = aqbot_core::repo::stored_file::create_stored_file(
            &db,
            "referenced-acp-file",
            &saved.hash,
            "workspace.tar",
            "application/x-tar",
            saved.size_bytes,
            &saved.storage_path,
            None,
        )
        .await
        .unwrap();
        let attachment = aqbot_core::types::Attachment {
            id: stored.id.clone(),
            file_type: stored.mime_type.clone(),
            file_name: stored.original_name.clone(),
            file_path: stored.storage_path.clone(),
            file_size: stored.size_bytes as u64,
            data: None,
        };
        aqbot_core::entity::acp_messages::ActiveModel {
            id: Set("acp-message-with-file".to_string()),
            thread_id: Set(thread.id),
            role: Set("user".to_string()),
            content: Set("Inspect this archive".to_string()),
            status: Set(Some("done".to_string())),
            attachments_json: Set(Some(serde_json::to_string(&[attachment]).unwrap())),
            meta_json: Set(None),
            created_at: Set(chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()),
        }
        .insert(&db)
        .await
        .unwrap();

        let error = delete_attachment_reference(&db, &file_store, &stored.id)
            .await
            .unwrap_err();

        assert!(error.contains("still referenced"));
        assert!(
            aqbot_core::repo::stored_file::get_stored_file(&db, &stored.id)
                .await
                .is_ok()
        );
        assert!(file_store.resolve_path(&saved.storage_path).exists());
    }

    #[tokio::test]
    async fn force_delete_keeps_a_missing_file_record_referenced_by_acp() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let root = tempfile::tempdir().unwrap();
        let file_store = aqbot_core::file_store::FileStore::with_root(root.path().to_path_buf());
        let project = aqbot_core::repo::acp::create_project(&db, "ACP missing", "/tmp")
            .await
            .unwrap();
        let thread = aqbot_core::repo::acp::create_thread(
            &db,
            &project.id,
            "test-agent",
            "Missing ACP file",
        )
        .await
        .unwrap();
        let saved = file_store
            .save_file(b"missing-acp-reference", "missing.zip", "application/zip")
            .unwrap();
        let stored = aqbot_core::repo::stored_file::create_stored_file(
            &db,
            "missing-acp-file",
            &saved.hash,
            "missing.zip",
            "application/zip",
            saved.size_bytes,
            &saved.storage_path,
            None,
        )
        .await
        .unwrap();
        let attachment = aqbot_core::types::Attachment {
            id: stored.id.clone(),
            file_type: stored.mime_type.clone(),
            file_name: stored.original_name.clone(),
            file_path: stored.storage_path.clone(),
            file_size: stored.size_bytes as u64,
            data: None,
        };
        aqbot_core::entity::acp_messages::ActiveModel {
            id: Set("acp-message-with-missing-file".to_string()),
            thread_id: Set(thread.id),
            role: Set("user".to_string()),
            content: Set(String::new()),
            status: Set(Some("done".to_string())),
            attachments_json: Set(Some(serde_json::to_string(&[attachment]).unwrap())),
            meta_json: Set(None),
            created_at: Set(chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()),
        }
        .insert(&db)
        .await
        .unwrap();
        std::fs::remove_file(file_store.resolve_path(&saved.storage_path)).unwrap();

        let error = force_delete_stored_file_record(&db, &file_store, &stored.id)
            .await
            .unwrap_err();

        assert!(error.contains("ACP message"));
        assert!(
            aqbot_core::repo::stored_file::get_stored_file(&db, &stored.id)
                .await
                .is_ok()
        );
    }

    #[tokio::test]
    async fn force_delete_removes_missing_file_still_referenced_by_chat() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let root = tempfile::tempdir().unwrap();
        let file_store = aqbot_core::file_store::FileStore::with_root(root.path().to_path_buf());
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &db,
            "Missing referenced file",
            "model",
            "provider",
            None,
        )
        .await
        .unwrap();
        let saved = file_store
            .save_file(b"missing-ref", "missing.png", "image/png")
            .unwrap();
        let stored = aqbot_core::repo::stored_file::create_stored_file(
            &db,
            "missing-chat-file",
            &saved.hash,
            "missing.png",
            "image/png",
            saved.size_bytes,
            &saved.storage_path,
            Some(&conversation.id),
        )
        .await
        .unwrap();
        aqbot_core::repo::message::create_message(
            &db,
            &conversation.id,
            aqbot_core::types::MessageRole::User,
            &format!("![attachment](aqbot-media://stored/{})", stored.id),
            &[],
            None,
            0,
        )
        .await
        .unwrap();

        // Simulate a missing backing file on disk.
        std::fs::remove_file(file_store.resolve_path(&saved.storage_path)).unwrap();

        force_delete_stored_file_record(&db, &file_store, &stored.id)
            .await
            .expect("force cleanup of missing referenced file should succeed");

        assert!(
            aqbot_core::repo::stored_file::get_stored_file(&db, &stored.id)
                .await
                .is_err(),
            "stored_files row must be removed"
        );
        // Message is intentionally left in place with a dead media id.
        let messages = aqbot_core::repo::message::list_messages(&db, &conversation.id)
            .await
            .unwrap();
        assert_eq!(messages.len(), 1);
        assert!(messages[0].content.contains(&stored.id));
    }

    #[tokio::test]
    async fn force_delete_removes_missing_file_still_referenced_by_drawing() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let root = tempfile::tempdir().unwrap();
        let file_store = aqbot_core::file_store::FileStore::with_root(root.path().to_path_buf());
        let saved = file_store
            .save_file(b"drawing-missing", "drawing-missing.png", "image/png")
            .unwrap();
        let stored = aqbot_core::repo::stored_file::create_stored_file(
            &db,
            "missing-drawing-file",
            &saved.hash,
            "drawing-missing.png",
            "image/png",
            saved.size_bytes,
            &saved.storage_path,
            None,
        )
        .await
        .unwrap();

        let generation = aqbot_core::repo::drawing::create_generation(
            &db,
            aqbot_core::repo::drawing::NewDrawingGeneration {
                parent_generation_id: None,
                provider_id: "provider".to_string(),
                key_id: "key".to_string(),
                model_id: "model".to_string(),
                action: "generate".to_string(),
                prompt: "test".to_string(),
                parameters_json: "{}".to_string(),
                reference_file_ids_json: "[]".to_string(),
                source_image_ids_json: "[]".to_string(),
                mask_file_id: None,
                adapter_id: None,
                adapter_config_snapshot: None,
                deadline_at: None,
            },
        )
        .await
        .unwrap();

        aqbot_core::entity::drawing_images::ActiveModel {
            id: Set("drawing-image-1".to_string()),
            generation_id: Set(generation.id.clone()),
            stored_file_id: Set(stored.id.clone()),
            storage_path: Set(saved.storage_path.clone()),
            mime_type: Set("image/png".to_string()),
            width: Set(Some(64)),
            height: Set(Some(64)),
            revised_prompt: Set(None),
            created_at: Set(aqbot_core::utils::now_ts()),
        }
        .insert(&db)
        .await
        .unwrap();

        std::fs::remove_file(file_store.resolve_path(&saved.storage_path)).unwrap();

        force_delete_stored_file_record(&db, &file_store, &stored.id)
            .await
            .expect("force cleanup of missing Drawing-referenced file should succeed");

        assert!(
            aqbot_core::repo::stored_file::get_stored_file(&db, &stored.id)
                .await
                .is_err(),
            "stored_files row must be removed even when Drawing still references it"
        );
    }

    #[tokio::test]
    async fn force_delete_keeps_shared_backing_file_until_last_record() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let root = tempfile::tempdir().unwrap();
        let file_store = aqbot_core::file_store::FileStore::with_root(root.path().to_path_buf());
        let saved = file_store
            .save_file(b"shared-bytes", "shared.png", "image/png")
            .unwrap();
        for file_id in ["shared-1", "shared-2"] {
            aqbot_core::repo::stored_file::create_stored_file(
                &db,
                file_id,
                &saved.hash,
                "shared.png",
                "image/png",
                saved.size_bytes,
                &saved.storage_path,
                None,
            )
            .await
            .unwrap();
        }

        force_delete_stored_file_record(&db, &file_store, "shared-1")
            .await
            .unwrap();

        assert!(file_store.resolve_path(&saved.storage_path).exists());
        assert!(
            aqbot_core::repo::stored_file::get_stored_file(&db, "shared-2")
                .await
                .is_ok()
        );

        force_delete_stored_file_record(&db, &file_store, "shared-2")
            .await
            .unwrap();
        assert!(!file_store.resolve_path(&saved.storage_path).exists());
    }
}
