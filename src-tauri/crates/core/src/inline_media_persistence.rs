use std::collections::HashMap;
use std::io::Read;

use sea_orm::{
    sea_query::OnConflict, ActiveModelTrait, ColumnTrait, ConnectionTrait, EntityTrait,
    QueryFilter, QueryOrder, QuerySelect, Set, TransactionTrait,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::entity::{inline_media_failures, messages, stored_files};
use crate::error::{AQBotError, Result};
use crate::file_store::FileStore;
use crate::inline_media::{
    prepare_message_inline_images, validate_image_bytes, CapturedInlineImage, InlineImageDocument,
    PreparedInlineMedia,
};
use crate::types::{Attachment, Message};

const MEDIA_URL_PREFIX: &str = "aqbot-media://stored/";

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineMediaMigrationFailure {
    pub message_id: String,
    pub error: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InlineMediaMigrationReport {
    pub candidates: usize,
    pub migrated: usize,
    pub failures: Vec<InlineMediaMigrationFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct InlineMediaDiagnostic {
    pub message_id: String,
    pub content_hash: String,
    pub error: String,
    pub updated_at: i64,
}

fn content_hash(content: &str) -> String {
    format!("{:x}", Sha256::digest(content.as_bytes()))
}

fn diagnostic_from_model(row: inline_media_failures::Model) -> InlineMediaDiagnostic {
    InlineMediaDiagnostic {
        message_id: row.message_id,
        content_hash: row.content_hash,
        error: row.error,
        updated_at: row.updated_at,
    }
}

pub async fn list_inline_media_diagnostics(
    db: &sea_orm::DatabaseConnection,
    conversation_id: Option<&str>,
) -> Result<Vec<InlineMediaDiagnostic>> {
    let mut query = inline_media_failures::Entity::find();
    if let Some(conversation_id) = conversation_id {
        let message_ids = messages::Entity::find()
            .filter(messages::Column::ConversationId.eq(conversation_id))
            .select_only()
            .column(messages::Column::Id)
            .into_tuple::<String>()
            .all(db)
            .await?;
        if message_ids.is_empty() {
            return Ok(Vec::new());
        }
        query = query.filter(inline_media_failures::Column::MessageId.is_in(message_ids));
    }
    Ok(query
        .order_by_asc(inline_media_failures::Column::MessageId)
        .all(db)
        .await?
        .into_iter()
        .map(diagnostic_from_model)
        .collect())
}

pub async fn matching_inline_media_diagnostic(
    db: &sea_orm::DatabaseConnection,
    message_id: &str,
    content: &str,
) -> Result<Option<InlineMediaDiagnostic>> {
    Ok(inline_media_failures::Entity::find_by_id(message_id)
        .one(db)
        .await?
        .filter(|row| row.content_hash == content_hash(content))
        .map(diagnostic_from_model))
}

pub async fn record_inline_media_failure(
    db: &sea_orm::DatabaseConnection,
    message_id: &str,
    content: &str,
    error: &str,
) -> Result<InlineMediaDiagnostic> {
    let diagnostic = InlineMediaDiagnostic {
        message_id: message_id.to_string(),
        content_hash: content_hash(content),
        error: error.to_string(),
        updated_at: crate::utils::now_ts(),
    };
    inline_media_failures::Entity::insert(inline_media_failures::ActiveModel {
        message_id: Set(diagnostic.message_id.clone()),
        content_hash: Set(diagnostic.content_hash.clone()),
        error: Set(diagnostic.error.clone()),
        updated_at: Set(diagnostic.updated_at),
    })
    .on_conflict(
        OnConflict::column(inline_media_failures::Column::MessageId)
            .update_columns([
                inline_media_failures::Column::ContentHash,
                inline_media_failures::Column::Error,
                inline_media_failures::Column::UpdatedAt,
            ])
            .to_owned(),
    )
    .exec(db)
    .await?;
    Ok(diagnostic)
}

async fn clear_inline_media_failure<C>(db: &C, message_id: &str) -> Result<()>
where
    C: ConnectionTrait,
{
    inline_media_failures::Entity::delete_by_id(message_id)
        .exec(db)
        .await?;
    Ok(())
}

pub async fn pending_inline_media_message_ids(
    db: &sea_orm::DatabaseConnection,
    conversation_id: Option<&str>,
) -> Result<Vec<String>> {
    let mut query =
        messages::Entity::find().filter(messages::Column::Content.contains("data:image/"));
    if let Some(conversation_id) = conversation_id {
        query = query.filter(messages::Column::ConversationId.eq(conversation_id));
    }
    let rows = query
        .select_only()
        .column(messages::Column::Id)
        .column(messages::Column::Content)
        .order_by_asc(messages::Column::Id)
        .into_tuple::<(String, String)>()
        .all(db)
        .await?;
    let failed_hashes = if rows.is_empty() {
        HashMap::new()
    } else {
        inline_media_failures::Entity::find()
            .filter(
                inline_media_failures::Column::MessageId
                    .is_in(rows.iter().map(|(id, _)| id.clone())),
            )
            .all(db)
            .await?
            .into_iter()
            .map(|failure| (failure.message_id, failure.content_hash))
            .collect::<HashMap<_, _>>()
    };
    Ok(rows
        .into_iter()
        .filter_map(|(id, content)| {
            if failed_hashes
                .get(&id)
                .is_some_and(|hash| hash == &content_hash(&content))
            {
                return None;
            }
            match super::extract_inline_images(&content) {
                Ok(document) if document.images().is_empty() => None,
                Ok(_) | Err(_) => Some(id),
            }
        })
        .collect())
}

pub async fn materialize_inline_media_messages(
    db: &sea_orm::DatabaseConnection,
    file_store: &FileStore,
    message_ids: &[String],
) -> Result<InlineMediaMigrationReport> {
    let mut report = InlineMediaMigrationReport {
        candidates: message_ids.len(),
        migrated: 0,
        failures: Vec::new(),
    };
    for message_id in message_ids {
        match crate::repo::message::get_message(db, message_id).await {
            Ok(message) => {
                match materialize_message_inline_images(
                    db,
                    file_store,
                    message_id,
                    &message.content,
                )
                .await
                {
                    Ok(_) => report.migrated += 1,
                    Err(error) => {
                        let error = error.to_string();
                        record_inline_media_failure(db, message_id, &message.content, &error)
                            .await?;
                        report.failures.push(InlineMediaMigrationFailure {
                            message_id: message_id.clone(),
                            error,
                        });
                    }
                }
            }
            Err(error) => report.failures.push(InlineMediaMigrationFailure {
                message_id: message_id.clone(),
                error: error.to_string(),
            }),
        }
    }
    Ok(report)
}

pub async fn materialize_message_inline_images(
    db: &sea_orm::DatabaseConnection,
    file_store: &FileStore,
    message_id: &str,
    content: &str,
) -> Result<Message> {
    let Some(prepared) = prepare_message_inline_images(content)? else {
        let updated = crate::repo::message::update_message_content(db, message_id, content).await?;
        clear_inline_media_failure(db, message_id).await?;
        return Ok(updated);
    };
    materialize_prepared_message_inline_images(db, file_store, message_id, &prepared).await
}

pub async fn materialize_prepared_message_inline_images(
    db: &sea_orm::DatabaseConnection,
    file_store: &FileStore,
    message_id: &str,
    prepared: &PreparedInlineMedia,
) -> Result<Message> {
    materialize_inline_image_document(db, file_store, message_id, prepared.document()).await
}

async fn materialize_inline_image_document(
    db: &sea_orm::DatabaseConnection,
    file_store: &FileStore,
    message_id: &str,
    document: &InlineImageDocument,
) -> Result<Message> {
    if document.images().is_empty() {
        return Err(AQBotError::Validation(
            "Prepared inline media document contains no images".to_string(),
        ));
    }
    let _file_reference_guard = crate::repo::stored_file::lock_file_references().await;

    let source = messages::Entity::find_by_id(message_id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Message {message_id}")))?;
    let mut attachments: Vec<Attachment> =
        serde_json::from_str(&source.attachments).map_err(|error| {
            AQBotError::Validation(format!("Invalid message attachments JSON: {error}"))
        })?;
    let txn = db.begin().await?;
    let mut created_paths = Vec::new();

    let operation = async {
        let mut media_by_hash = HashMap::<String, Attachment>::new();
        let mut new_attachments = Vec::new();
        let mut urls = Vec::with_capacity(document.images().len());
        for image in document.images() {
            let hash = format!("{:x}", Sha256::digest(&image.bytes));
            let attachment = if let Some(existing) = media_by_hash.get(&hash) {
                existing.clone()
            } else {
                let extension = extension_for_mime(&image.mime_type);
                let original_name = format!("inline.{extension}");
                let saved = file_store.save_file(&image.bytes, &original_name, &image.mime_type)?;
                if saved.created {
                    created_paths.push(saved.storage_path.clone());
                }
                let id = crate::utils::gen_id();
                stored_files::ActiveModel {
                    id: Set(id.clone()),
                    hash: Set(saved.hash.clone()),
                    original_name: Set(original_name.clone()),
                    mime_type: Set(image.mime_type.clone()),
                    size_bytes: Set(saved.size_bytes),
                    storage_path: Set(saved.storage_path.clone()),
                    conversation_id: Set(Some(source.conversation_id.clone())),
                    ..Default::default()
                }
                .insert(&txn)
                .await?;
                let attachment = Attachment {
                    id,
                    file_type: image.mime_type.clone(),
                    file_name: original_name,
                    file_path: saved.storage_path,
                    file_size: image.bytes.len() as u64,
                    data: None,
                };
                media_by_hash.insert(hash, attachment.clone());
                new_attachments.push(attachment.clone());
                attachment
            };
            urls.push(format!("{MEDIA_URL_PREFIX}{}", attachment.id));
        }

        attachments.extend(new_attachments);
        let rewritten = document.rewrite(&urls)?;
        let attachments_json = serde_json::to_string(&attachments).map_err(|error| {
            AQBotError::Validation(format!("Failed to serialize message attachments: {error}"))
        })?;
        let mut update: messages::ActiveModel = source.into();
        update.content = Set(rewritten);
        update.attachments = Set(attachments_json);
        let updated = update.update(&txn).await?;
        clear_inline_media_failure(&txn, message_id).await?;
        crate::repo::message::message_from_entity(updated)
    }
    .await;

    let message = match operation {
        Ok(message) => message,
        Err(error) => {
            let rollback_error = txn.rollback().await.err();
            let cleanup_errors = cleanup_created_files(db, file_store, &created_paths).await;
            return Err(combine_failures(error, rollback_error, cleanup_errors));
        }
    };
    if let Err(error) = txn.commit().await {
        let cleanup_errors = cleanup_created_files(db, file_store, &created_paths).await;
        return Err(combine_failures(error.into(), None, cleanup_errors));
    }
    Ok(message)
}

pub async fn materialize_streamed_inline_images(
    db: &sea_orm::DatabaseConnection,
    file_store: &FileStore,
    message_id: &str,
    content: &str,
    images: &[CapturedInlineImage],
) -> Result<Message> {
    if images.is_empty() {
        let updated = crate::repo::message::update_message_content(db, message_id, content).await?;
        clear_inline_media_failure(db, message_id).await?;
        return Ok(updated);
    }
    let _file_reference_guard = crate::repo::stored_file::lock_file_references().await;
    let source = messages::Entity::find_by_id(message_id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Message {message_id}")))?;
    let mut attachments: Vec<Attachment> =
        serde_json::from_str(&source.attachments).map_err(|error| {
            AQBotError::Validation(format!("Invalid message attachments JSON: {error}"))
        })?;
    let txn = db.begin().await?;
    let mut created_paths = Vec::new();

    let operation = async {
        let mut media_by_hash = HashMap::<String, Attachment>::new();
        let mut replacements = Vec::new();
        for image in images {
            if !content.contains(image.token()) {
                continue;
            }
            let extension = extension_for_mime(image.mime_type());
            let original_name = format!("inline.{extension}");
            let decoded = std::fs::File::open(image.decoded_path())?;
            let saved = file_store.save_reader(decoded, &original_name, image.mime_type())?;
            if saved.created {
                created_paths.push(saved.storage_path.clone());
            }
            if saved.size_bytes > super::MAX_INLINE_IMAGE_BYTES as i64 {
                return Err(AQBotError::Validation(format!(
                    "Inline image exceeds the {} byte limit",
                    super::MAX_INLINE_IMAGE_BYTES
                )));
            }
            validate_saved_image(file_store, &saved.storage_path, image.mime_type())?;

            let attachment = if let Some(existing) = media_by_hash.get(&saved.hash) {
                existing.clone()
            } else {
                let id = crate::utils::gen_id();
                stored_files::ActiveModel {
                    id: Set(id.clone()),
                    hash: Set(saved.hash.clone()),
                    original_name: Set(original_name.clone()),
                    mime_type: Set(image.mime_type().to_string()),
                    size_bytes: Set(saved.size_bytes),
                    storage_path: Set(saved.storage_path.clone()),
                    conversation_id: Set(Some(source.conversation_id.clone())),
                    ..Default::default()
                }
                .insert(&txn)
                .await?;
                let attachment = Attachment {
                    id,
                    file_type: image.mime_type().to_string(),
                    file_name: original_name,
                    file_path: saved.storage_path,
                    file_size: saved.size_bytes as u64,
                    data: None,
                };
                media_by_hash.insert(saved.hash, attachment.clone());
                attachments.push(attachment.clone());
                attachment
            };
            replacements.push((
                image.token().to_string(),
                format!("{MEDIA_URL_PREFIX}{}", attachment.id),
            ));
        }

        let rewritten = replacements
            .into_iter()
            .fold(content.to_string(), |text, (token, url)| {
                text.replace(&token, &url)
            });
        let attachments_json = serde_json::to_string(&attachments).map_err(|error| {
            AQBotError::Validation(format!("Failed to serialize message attachments: {error}"))
        })?;
        let mut update: messages::ActiveModel = source.into();
        update.content = Set(rewritten);
        update.attachments = Set(attachments_json);
        let updated = update.update(&txn).await?;
        clear_inline_media_failure(&txn, message_id).await?;
        crate::repo::message::message_from_entity(updated)
    }
    .await;

    let message = match operation {
        Ok(message) => message,
        Err(error) => {
            let rollback_error = txn.rollback().await.err();
            let cleanup_errors = cleanup_created_files(db, file_store, &created_paths).await;
            return Err(combine_failures(error, rollback_error, cleanup_errors));
        }
    };
    if let Err(error) = txn.commit().await {
        let cleanup_errors = cleanup_created_files(db, file_store, &created_paths).await;
        return Err(combine_failures(error.into(), None, cleanup_errors));
    }
    Ok(message)
}

fn validate_saved_image(file_store: &FileStore, storage_path: &str, mime_type: &str) -> Result<()> {
    let mut file = std::fs::File::open(file_store.validated_path(storage_path)?)?;
    let mut header = [0_u8; 16];
    let read = file.read(&mut header)?;
    validate_image_bytes(mime_type, &header[..read])
}

fn extension_for_mime(mime_type: &str) -> &'static str {
    match mime_type {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => "img",
    }
}

async fn cleanup_created_files(
    db: &sea_orm::DatabaseConnection,
    file_store: &FileStore,
    paths: &[String],
) -> Vec<String> {
    let mut errors = Vec::new();
    for path in paths {
        match crate::repo::stored_file::count_stored_files_with_storage_path(db, path).await {
            Ok(0) => {
                if let Err(error) = file_store.delete_file(path) {
                    errors.push(format!("failed to remove {path}: {error}"));
                }
            }
            Ok(_) => {}
            Err(error) => errors.push(format!("failed to inspect {path}: {error}")),
        }
    }
    errors
}

fn combine_failures(
    primary: AQBotError,
    rollback: Option<sea_orm::DbErr>,
    cleanup: Vec<String>,
) -> AQBotError {
    if rollback.is_none() && cleanup.is_empty() {
        return primary;
    }
    AQBotError::Validation(format!(
        "{primary}; rollback error: {}; cleanup errors: {}",
        rollback
            .map(|error| error.to_string())
            .unwrap_or_else(|| "none".to_string()),
        if cleanup.is_empty() {
            "none".to_string()
        } else {
            cleanup.join(", ")
        }
    ))
}
