use sea_orm::{DatabaseConnection, EntityTrait, TransactionTrait};
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
                "Stored file {record_id} is still referenced by a message or Drawing resource"
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

#[cfg(test)]
mod tests {
    use super::*;

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
        assert!(aqbot_core::repo::stored_file::get_stored_file(&db, &stored.id)
            .await
            .is_ok());
        assert!(file_store.resolve_path(&saved.storage_path).exists());
    }
}
