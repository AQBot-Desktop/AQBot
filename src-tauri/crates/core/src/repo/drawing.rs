use sea_orm::*;
use serde::{Deserialize, Serialize};

use crate::entity::{drawing_generations, drawing_images};
use crate::error::{AQBotError, Result};
use crate::repo::stored_file::StoredFile;
use crate::utils::{gen_id, now_ts};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrawingImage {
    pub id: String,
    pub generation_id: String,
    pub stored_file_id: String,
    pub storage_path: String,
    pub mime_type: String,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub revised_prompt: Option<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrawingGeneration {
    pub id: String,
    pub parent_generation_id: Option<String>,
    pub provider_id: String,
    pub key_id: String,
    pub model_id: String,
    pub api_kind: String,
    pub action: String,
    pub prompt: String,
    pub parameters_json: String,
    pub reference_file_ids_json: String,
    pub source_image_ids_json: String,
    pub mask_file_id: Option<String>,
    pub status: String,
    pub error_message: Option<String>,
    pub response_id: Option<String>,
    pub usage_json: Option<String>,
    pub created_at: i64,
    pub completed_at: Option<i64>,
    pub images: Vec<DrawingImage>,
    #[serde(default)]
    pub reference_files: Vec<StoredFile>,
    #[serde(default)]
    pub source_images: Vec<DrawingImage>,
    pub mask_file: Option<StoredFile>,
}

#[derive(Debug, Clone)]
pub struct NewDrawingGeneration {
    pub parent_generation_id: Option<String>,
    pub provider_id: String,
    pub key_id: String,
    pub model_id: String,
    pub action: String,
    pub prompt: String,
    pub parameters_json: String,
    pub reference_file_ids_json: String,
    pub source_image_ids_json: String,
    pub mask_file_id: Option<String>,
}

#[derive(Debug, Clone)]
pub struct NewDrawingImage {
    pub generation_id: String,
    pub stored_file_id: String,
    pub storage_path: String,
    pub mime_type: String,
    pub width: Option<i32>,
    pub height: Option<i32>,
    pub revised_prompt: Option<String>,
}

fn image_from_entity(model: drawing_images::Model) -> DrawingImage {
    DrawingImage {
        id: model.id,
        generation_id: model.generation_id,
        stored_file_id: model.stored_file_id,
        storage_path: model.storage_path,
        mime_type: model.mime_type,
        width: model.width,
        height: model.height,
        revised_prompt: model.revised_prompt,
        created_at: model.created_at,
    }
}

fn generation_from_entity(
    model: drawing_generations::Model,
    images: Vec<DrawingImage>,
    reference_files: Vec<StoredFile>,
    source_images: Vec<DrawingImage>,
    mask_file: Option<StoredFile>,
) -> DrawingGeneration {
    DrawingGeneration {
        id: model.id,
        parent_generation_id: model.parent_generation_id,
        provider_id: model.provider_id,
        key_id: model.key_id,
        model_id: model.model_id,
        api_kind: model.api_kind,
        action: model.action,
        prompt: model.prompt,
        parameters_json: model.parameters_json,
        reference_file_ids_json: model.reference_file_ids_json,
        source_image_ids_json: model.source_image_ids_json,
        mask_file_id: model.mask_file_id,
        status: model.status,
        error_message: model.error_message,
        response_id: model.response_id,
        usage_json: model.usage_json,
        created_at: model.created_at,
        completed_at: model.completed_at,
        images,
        reference_files,
        source_images,
        mask_file,
    }
}

fn parse_id_list(raw: &str) -> Vec<String> {
    serde_json::from_str::<Vec<String>>(raw).unwrap_or_default()
}

async fn list_reference_files(
    db: &DatabaseConnection,
    ids_json: &str,
) -> Result<Vec<StoredFile>> {
    let mut files = Vec::new();
    for id in parse_id_list(ids_json) {
        if let Ok(file) = crate::repo::stored_file::get_stored_file(db, &id).await {
            files.push(file);
        }
    }
    Ok(files)
}

async fn list_source_images(
    db: &DatabaseConnection,
    ids_json: &str,
) -> Result<Vec<DrawingImage>> {
    let mut images = Vec::new();
    for id in parse_id_list(ids_json) {
        if let Ok(image) = get_image(db, &id).await {
            images.push(image);
        }
    }
    Ok(images)
}

async fn get_mask_file(
    db: &DatabaseConnection,
    mask_file_id: Option<&str>,
) -> Result<Option<StoredFile>> {
    let Some(mask_file_id) = mask_file_id else {
        return Ok(None);
    };
    Ok(crate::repo::stored_file::get_stored_file(db, mask_file_id)
        .await
        .ok())
}

async fn hydrate_generation(
    db: &DatabaseConnection,
    row: drawing_generations::Model,
) -> Result<DrawingGeneration> {
    let id = row.id.clone();
    let images = list_images_for_generation(db, &id).await?;
    let reference_files = list_reference_files(db, &row.reference_file_ids_json).await?;
    let source_images = list_source_images(db, &row.source_image_ids_json).await?;
    let mask_file = get_mask_file(db, row.mask_file_id.as_deref()).await?;
    Ok(generation_from_entity(
        row,
        images,
        reference_files,
        source_images,
        mask_file,
    ))
}

pub async fn create_generation(
    db: &DatabaseConnection,
    input: NewDrawingGeneration,
) -> Result<DrawingGeneration> {
    let id = gen_id();
    let now = now_ts();

    drawing_generations::ActiveModel {
        id: Set(id.clone()),
        parent_generation_id: Set(input.parent_generation_id),
        provider_id: Set(input.provider_id),
        key_id: Set(input.key_id),
        model_id: Set(input.model_id),
        api_kind: Set("image_api".to_string()),
        action: Set(input.action),
        prompt: Set(input.prompt),
        parameters_json: Set(input.parameters_json),
        reference_file_ids_json: Set(input.reference_file_ids_json),
        source_image_ids_json: Set(input.source_image_ids_json),
        mask_file_id: Set(input.mask_file_id),
        status: Set("running".to_string()),
        error_message: Set(None),
        response_id: Set(None),
        usage_json: Set(None),
        created_at: Set(now),
        completed_at: Set(None),
    }
    .insert(db)
    .await?;

    get_generation(db, &id).await
}

pub async fn add_image(db: &DatabaseConnection, input: NewDrawingImage) -> Result<DrawingImage> {
    let id = gen_id();
    let now = now_ts();

    drawing_images::ActiveModel {
        id: Set(id.clone()),
        generation_id: Set(input.generation_id),
        stored_file_id: Set(input.stored_file_id),
        storage_path: Set(input.storage_path),
        mime_type: Set(input.mime_type),
        width: Set(input.width),
        height: Set(input.height),
        revised_prompt: Set(input.revised_prompt),
        created_at: Set(now),
    }
    .insert(db)
    .await?;

    get_image(db, &id).await
}

pub async fn mark_generation_succeeded(
    db: &DatabaseConnection,
    id: &str,
    response_id: Option<String>,
    usage_json: Option<String>,
) -> Result<()> {
    let row = drawing_generations::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("DrawingGeneration {}", id)))?;
    let mut am: drawing_generations::ActiveModel = row.into();
    am.status = Set("succeeded".to_string());
    am.error_message = Set(None);
    am.response_id = Set(response_id);
    am.usage_json = Set(usage_json);
    am.completed_at = Set(Some(now_ts()));
    am.update(db).await?;
    Ok(())
}

pub async fn mark_generation_failed(
    db: &DatabaseConnection,
    id: &str,
    error_message: String,
) -> Result<()> {
    let row = drawing_generations::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("DrawingGeneration {}", id)))?;
    let mut am: drawing_generations::ActiveModel = row.into();
    am.status = Set("failed".to_string());
    am.error_message = Set(Some(error_message));
    am.completed_at = Set(Some(now_ts()));
    am.update(db).await?;
    Ok(())
}

pub async fn get_image(db: &DatabaseConnection, id: &str) -> Result<DrawingImage> {
    let row = drawing_images::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("DrawingImage {}", id)))?;
    Ok(image_from_entity(row))
}

pub async fn get_generation(db: &DatabaseConnection, id: &str) -> Result<DrawingGeneration> {
    let row = drawing_generations::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("DrawingGeneration {}", id)))?;
    hydrate_generation(db, row).await
}

pub async fn list_images_for_generation(
    db: &DatabaseConnection,
    generation_id: &str,
) -> Result<Vec<DrawingImage>> {
    let rows = drawing_images::Entity::find()
        .filter(drawing_images::Column::GenerationId.eq(generation_id))
        .order_by_asc(drawing_images::Column::CreatedAt)
        .all(db)
        .await?;
    Ok(rows.into_iter().map(image_from_entity).collect())
}

pub async fn list_generations(
    db: &DatabaseConnection,
    limit: u64,
    cursor: Option<i64>,
) -> Result<Vec<DrawingGeneration>> {
    let mut query = drawing_generations::Entity::find()
        .order_by_desc(drawing_generations::Column::CreatedAt)
        .limit(limit.min(100));
    if let Some(cursor) = cursor {
        query = query.filter(drawing_generations::Column::CreatedAt.lt(cursor));
    }
    let rows = query.all(db).await?;
    let mut result = Vec::with_capacity(rows.len());
    for row in rows {
        result.push(hydrate_generation(db, row).await?);
    }
    Ok(result)
}

pub async fn delete_generation(db: &DatabaseConnection, id: &str) -> Result<()> {
    drawing_images::Entity::delete_many()
        .filter(drawing_images::Column::GenerationId.eq(id))
        .exec(db)
        .await?;
    let result = drawing_generations::Entity::delete_by_id(id)
        .exec(db)
        .await?;
    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("DrawingGeneration {}", id)));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::create_test_pool;
    use crate::repo::stored_file;

    #[tokio::test]
    async fn hydrates_reference_source_and_mask_files() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;

        let source_file = stored_file::create_stored_file(
            db,
            &gen_id(),
            "source-hash",
            "source.png",
            "image/png",
            1024,
            "images/source.png",
            None,
        )
        .await
        .unwrap();
        let ref_file = stored_file::create_stored_file(
            db,
            &gen_id(),
            "ref-hash",
            "ref.png",
            "image/png",
            2048,
            "images/ref.png",
            None,
        )
        .await
        .unwrap();
        let mask_file = stored_file::create_stored_file(
            db,
            &gen_id(),
            "mask-hash",
            "mask.png",
            "image/png",
            512,
            "images/mask.png",
            None,
        )
        .await
        .unwrap();

        let source_generation = create_generation(
            db,
            NewDrawingGeneration {
                parent_generation_id: None,
                provider_id: "provider-1".into(),
                key_id: "key-1".into(),
                model_id: "gpt-image-2".into(),
                action: "generate".into(),
                prompt: "source".into(),
                parameters_json: "{}".into(),
                reference_file_ids_json: "[]".into(),
                source_image_ids_json: "[]".into(),
                mask_file_id: None,
            },
        )
        .await
        .unwrap();
        let source_image = add_image(
            db,
            NewDrawingImage {
                generation_id: source_generation.id.clone(),
                stored_file_id: source_file.id.clone(),
                storage_path: source_file.storage_path.clone(),
                mime_type: source_file.mime_type.clone(),
                width: Some(1024),
                height: Some(1024),
                revised_prompt: None,
            },
        )
        .await
        .unwrap();

        let edit_generation = create_generation(
            db,
            NewDrawingGeneration {
                parent_generation_id: Some(source_generation.id),
                provider_id: "provider-1".into(),
                key_id: "key-1".into(),
                model_id: "gpt-image-2".into(),
                action: "mask_edit".into(),
                prompt: "edit".into(),
                parameters_json: "{}".into(),
                reference_file_ids_json: serde_json::to_string(&vec![ref_file.id.clone()]).unwrap(),
                source_image_ids_json: serde_json::to_string(&vec![source_image.id.clone()])
                    .unwrap(),
                mask_file_id: Some(mask_file.id.clone()),
            },
        )
        .await
        .unwrap();

        let fetched = get_generation(db, &edit_generation.id).await.unwrap();
        assert_eq!(fetched.reference_files.len(), 1);
        assert_eq!(fetched.reference_files[0].id, ref_file.id);
        assert_eq!(fetched.source_images.len(), 1);
        assert_eq!(fetched.source_images[0].id, source_image.id);
        assert_eq!(
            fetched.mask_file.as_ref().map(|file| file.id.as_str()),
            Some(mask_file.id.as_str())
        );
    }
}
