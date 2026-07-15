use sea_orm::*;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::OnceLock;

use crate::entity::{drawing_generations, drawing_images, messages, stored_files};
use crate::error::{AQBotError, Result};
use crate::types::Attachment;

const STORED_MEDIA_URL_PREFIXES: &[&str] = &[
    "aqbot-media://stored/",
    "http://aqbot-media.localhost/stored/",
    "https://aqbot-media.localhost/stored/",
    "http://localhost/stored/",
    "https://localhost/stored/",
];

fn file_reference_lock() -> &'static tokio::sync::Mutex<()> {
    static LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| tokio::sync::Mutex::new(()))
}

pub async fn lock_file_references() -> tokio::sync::MutexGuard<'static, ()> {
    file_reference_lock().lock().await
}

fn find_ascii_case_insensitive(value: &str, pattern: &str) -> Option<usize> {
    value
        .as_bytes()
        .windows(pattern.len())
        .position(|window| window.eq_ignore_ascii_case(pattern.as_bytes()))
}

/// Return the byte ranges of stored-file IDs in AQBot's media protocol forms.
/// IDs are deliberately restricted to the protocol's safe path-segment
/// alphabet so surrounding Markdown/HTML punctuation is excluded.
pub(crate) fn stored_media_id_ranges(content: &str) -> Vec<(usize, usize)> {
    let mut ranges = Vec::new();
    let mut offset = 0;
    while offset < content.len() {
        let next = STORED_MEDIA_URL_PREFIXES
            .iter()
            .filter_map(|prefix| {
                find_ascii_case_insensitive(&content[offset..], prefix)
                    .map(|relative| (relative, prefix.len()))
            })
            .min_by_key(|(relative, _)| *relative);
        let Some((relative, prefix_len)) = next else {
            break;
        };
        let id_start = offset + relative + prefix_len;
        let id_len = content.as_bytes()[id_start..]
            .iter()
            .take_while(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
            .count();
        if id_len == 0 {
            offset = id_start;
            continue;
        }
        let id_end = id_start + id_len;
        ranges.push((id_start, id_end));
        offset = id_end;
    }
    ranges
}

/// Return every stored-file ID referenced by AQBot's media protocol forms.
pub fn stored_media_ids(content: &str) -> HashSet<String> {
    stored_media_id_ranges(content)
        .into_iter()
        .map(|(start, end)| content[start..end].to_string())
        .collect()
}

/// Resolve media references from both message content and attachment metadata.
/// Malformed attachment JSON is an explicit error: deleting in that state could
/// otherwise incorrectly treat a still-referenced file as orphaned.
pub fn message_stored_file_ids(
    content: &str,
    attachments_json: &str,
) -> Result<HashSet<String>> {
    let attachments: Vec<Attachment> = serde_json::from_str(attachments_json).map_err(|error| {
        AQBotError::Validation(format!(
            "Invalid message attachments JSON while collecting media references: {error}"
        ))
    })?;
    let mut ids = stored_media_ids(content);
    ids.extend(
        attachments
            .into_iter()
            .map(|attachment| attachment.id)
            .filter(|id| !id.is_empty()),
    );
    Ok(ids)
}

/// Delete only candidate stored-file rows that have no remaining reference in
/// messages or Drawing. This must be called inside a transaction while the
/// global file-reference lock is held. Returned paths have no remaining
/// stored_files row and can therefore be removed from disk after commit.
pub async fn delete_unreferenced_candidates<C>(
    db: &C,
    candidate_ids: &HashSet<String>,
) -> Result<Vec<String>>
where
    C: ConnectionTrait,
{
    if candidate_ids.is_empty() {
        return Ok(Vec::new());
    }

    let message_rows = messages::Entity::find().all(db).await?;
    let mut referenced_ids = HashSet::new();
    for message in message_rows {
        referenced_ids.extend(message_stored_file_ids(
            &message.content,
            &message.attachments,
        )?);
    }

    referenced_ids.extend(
        drawing_images::Entity::find()
            .all(db)
            .await?
            .into_iter()
            .map(|image| image.stored_file_id),
    );
    for generation in drawing_generations::Entity::find().all(db).await? {
        if let Some(mask_file_id) = generation.mask_file_id {
            referenced_ids.insert(mask_file_id);
        }
        let reference_file_ids: Vec<String> =
            serde_json::from_str(&generation.reference_file_ids_json).map_err(|error| {
                AQBotError::Validation(format!(
                    "Invalid Drawing reference_file_ids_json while collecting media references: {error}"
                ))
            })?;
        referenced_ids.extend(reference_file_ids.into_iter().filter(|id| !id.is_empty()));
    }

    let mut removed_paths = HashSet::new();
    for candidate_id in candidate_ids {
        if referenced_ids.contains(candidate_id) {
            continue;
        }
        let Some(file) = stored_files::Entity::find_by_id(candidate_id).one(db).await? else {
            continue;
        };
        stored_files::Entity::delete_by_id(candidate_id).exec(db).await?;
        removed_paths.insert(file.storage_path);
    }

    let mut unreferenced_paths = Vec::new();
    for path in removed_paths {
        let remaining = stored_files::Entity::find()
            .filter(stored_files::Column::StoragePath.eq(&path))
            .count(db)
            .await?;
        if remaining == 0 {
            unreferenced_paths.push(path);
        }
    }
    unreferenced_paths.sort();
    Ok(unreferenced_paths)
}

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

    let model = am.insert(db).await?;
    Ok(model_to_stored_file(model))
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

#[cfg(test)]
mod tests {
    use super::stored_media_ids;

    #[test]
    fn stored_media_id_uses_the_same_alphabet_as_the_media_protocol() {
        let ids = stored_media_ids(
            "![one](aqbot-media://stored/id_1.) and https://aqbot-media.localhost/stored/id-2~",
        );

        assert!(ids.contains("id_1"));
        assert!(ids.contains("id-2"));
        assert!(!ids.contains("id_1."));
        assert!(!ids.contains("id-2~"));
    }
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

pub async fn find_by_hash(db: &DatabaseConnection, hash: &str) -> Result<Option<StoredFile>> {
    let model = stored_files::Entity::find()
        .filter(stored_files::Column::Hash.eq(hash))
        .one(db)
        .await?;

    Ok(model.map(model_to_stored_file))
}
