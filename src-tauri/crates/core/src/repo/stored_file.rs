use sea_orm::*;
use serde::{Deserialize, Serialize};

use crate::entity::stored_files;
use crate::error::{AQBotError, Result};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredFile {
    pub id: String,
    pub hash: String,
    pub original_name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub storage_path: String,
    pub conversation_id: Option<String>,
    pub created_at: String,
}

fn model_to_stored_file(m: stored_files::Model) -> StoredFile {
    StoredFile {
        id: m.id,
        hash: m.hash,
        original_name: m.original_name,
        mime_type: m.mime_type,
        size_bytes: m.size_bytes,
        storage_path: m.storage_path,
        conversation_id: m.conversation_id,
        created_at: m.created_at,
    }
}

pub async fn create_stored_file(
    db: &DatabaseConnection,
    id: &str,
    hash: &str,
    original_name: &str,
    mime_type: &str,
    size_bytes: i64,
    storage_path: &str,
    conversation_id: Option<&str>,
) -> Result<StoredFile> {
    let am = stored_files::ActiveModel {
        id: Set(id.to_string()),
        hash: Set(hash.to_string()),
        original_name: Set(original_name.to_string()),
        mime_type: Set(mime_type.to_string()),
        size_bytes: Set(size_bytes),
        storage_path: Set(storage_path.to_string()),
        conversation_id: Set(conversation_id.map(|s| s.to_string())),
        ..Default::default()
    };

    am.insert(db).await?;

    get_stored_file(db, id).await
}

pub async fn get_stored_file(db: &DatabaseConnection, id: &str) -> Result<StoredFile> {
    let model = stored_files::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("StoredFile {}", id)))?;

    Ok(model_to_stored_file(model))
}

pub async fn list_stored_files_by_conversation(
    db: &DatabaseConnection,
    conversation_id: &str,
) -> Result<Vec<StoredFile>> {
    let models = stored_files::Entity::find()
        .filter(stored_files::Column::ConversationId.eq(conversation_id))
        .order_by_desc(stored_files::Column::CreatedAt)
        .all(db)
        .await?;

    Ok(models.into_iter().map(model_to_stored_file).collect())
}

pub async fn delete_stored_file(db: &DatabaseConnection, id: &str) -> Result<()> {
    let result = stored_files::Entity::delete_by_id(id).exec(db).await?;

    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("StoredFile {}", id)));
    }
    Ok(())
}

pub async fn delete_stored_files_by_conversation(
    db: &DatabaseConnection,
    conversation_id: &str,
) -> Result<()> {
    stored_files::Entity::delete_many()
        .filter(stored_files::Column::ConversationId.eq(conversation_id))
        .exec(db)
        .await?;

    Ok(())
}

pub async fn list_all_stored_files(db: &DatabaseConnection) -> Result<Vec<StoredFile>> {
    let models = stored_files::Entity::find()
        .order_by_desc(stored_files::Column::CreatedAt)
        .all(db)
        .await?;
    Ok(models.into_iter().map(model_to_stored_file).collect())
}

pub async fn count_stored_files_with_storage_path(
    db: &DatabaseConnection,
    storage_path: &str,
) -> Result<u64> {
    stored_files::Entity::find()
        .filter(stored_files::Column::StoragePath.eq(storage_path))
        .count(db)
        .await
        .map_err(Into::into)
}

pub async fn find_by_hash(
    db: &DatabaseConnection,
    hash: &str,
) -> Result<Option<StoredFile>> {
    let model = stored_files::Entity::find()
        .filter(stored_files::Column::Hash.eq(hash))
        .one(db)
        .await?;

    Ok(model.map(model_to_stored_file))
}
