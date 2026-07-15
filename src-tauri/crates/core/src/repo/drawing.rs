use sea_orm::*;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};

use crate::entity::{drawing_generations, drawing_images, stored_files};
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

fn stored_file_from_entity(model: stored_files::Model) -> StoredFile {
    StoredFile {
        id: model.id,
        hash: model.hash,
        original_name: model.original_name,
        mime_type: model.mime_type,
        size_bytes: model.size_bytes,
        storage_path: model.storage_path,
        conversation_id: model.conversation_id,
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

fn parse_id_list(raw: &str, generation_id: &str, field: &str) -> Result<Vec<String>> {
    serde_json::from_str::<Vec<String>>(raw).map_err(|error| {
        AQBotError::Validation(format!(
            "Drawing generation {generation_id} has invalid {field}: {error}"
        ))
    })
}

struct GenerationMediaIds {
    reference_file_ids: Vec<String>,
    source_image_ids: Vec<String>,
}

impl TryFrom<&drawing_generations::Model> for GenerationMediaIds {
    type Error = AQBotError;

    fn try_from(row: &drawing_generations::Model) -> Result<Self> {
        Ok(Self {
            reference_file_ids: parse_id_list(
                &row.reference_file_ids_json,
                &row.id,
                "reference_file_ids_json",
            )?,
            source_image_ids: parse_id_list(
                &row.source_image_ids_json,
                &row.id,
                "source_image_ids_json",
            )?,
        })
    }
}

fn collect_source_image_ids(media_ids: &[GenerationMediaIds]) -> HashSet<String> {
    media_ids
        .iter()
        .flat_map(|ids| ids.source_image_ids.iter().cloned())
        .collect()
}

fn collect_stored_file_ids(
    rows: &[drawing_generations::Model],
    media_ids: &[GenerationMediaIds],
) -> HashSet<String> {
    rows.iter()
        .zip(media_ids)
        .flat_map(|(row, ids)| {
            ids.reference_file_ids
                .iter()
                .cloned()
                .chain(row.mask_file_id.iter().cloned())
        })
        .collect()
}

async fn list_reference_files(
    db: &DatabaseConnection,
    generation_id: &str,
    ids_json: &str,
) -> Result<Vec<StoredFile>> {
    let mut files = Vec::new();
    for id in parse_id_list(ids_json, generation_id, "reference_file_ids_json")? {
        files.push(crate::repo::stored_file::get_stored_file(db, &id).await?);
    }
    Ok(files)
}

async fn list_source_images(
    db: &DatabaseConnection,
    generation_id: &str,
    ids_json: &str,
) -> Result<Vec<DrawingImage>> {
    let mut images = Vec::new();
    for id in parse_id_list(ids_json, generation_id, "source_image_ids_json")? {
        images.push(get_image(db, &id).await?);
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
    Ok(Some(
        crate::repo::stored_file::get_stored_file(db, mask_file_id).await?,
    ))
}

async fn hydrate_generation(
    db: &DatabaseConnection,
    row: drawing_generations::Model,
) -> Result<DrawingGeneration> {
    let id = row.id.clone();
    let images = list_images_for_generation(db, &id).await?;
    let reference_files = list_reference_files(db, &id, &row.reference_file_ids_json).await?;
    let source_images = list_source_images(db, &id, &row.source_image_ids_json).await?;
    let mask_file = get_mask_file(db, row.mask_file_id.as_deref()).await?;
    Ok(generation_from_entity(
        row,
        images,
        reference_files,
        source_images,
        mask_file,
    ))
}

async fn load_batch_images(
    db: &DatabaseConnection,
    generation_ids: Vec<String>,
    source_image_ids: HashSet<String>,
) -> Result<(
    HashMap<String, Vec<DrawingImage>>,
    HashMap<String, DrawingImage>,
)> {
    let generation_id_set = generation_ids.iter().cloned().collect::<HashSet<_>>();
    let mut image_condition =
        Condition::any().add(drawing_images::Column::GenerationId.is_in(generation_ids));
    // Source images can belong to generations outside the current history page.
    if !source_image_ids.is_empty() {
        image_condition = image_condition.add(drawing_images::Column::Id.is_in(source_image_ids));
    }
    let image_rows = drawing_images::Entity::find()
        .filter(image_condition)
        .order_by_asc(drawing_images::Column::CreatedAt)
        .all(db)
        .await?;

    let mut images_by_generation = HashMap::<String, Vec<DrawingImage>>::new();
    let mut images_by_id = HashMap::<String, DrawingImage>::new();
    for row in image_rows {
        let image = image_from_entity(row);
        if generation_id_set.contains(&image.generation_id) {
            images_by_generation
                .entry(image.generation_id.clone())
                .or_default()
                .push(image.clone());
        }
        images_by_id.insert(image.id.clone(), image);
    }
    Ok((images_by_generation, images_by_id))
}

async fn load_batch_stored_files(
    db: &DatabaseConnection,
    stored_file_ids: HashSet<String>,
) -> Result<HashMap<String, StoredFile>> {
    if stored_file_ids.is_empty() {
        return Ok(HashMap::new());
    }
    let rows = stored_files::Entity::find()
        .filter(stored_files::Column::Id.is_in(stored_file_ids))
        .all(db)
        .await?;
    Ok(rows
        .into_iter()
        .map(stored_file_from_entity)
        .map(|file| (file.id.clone(), file))
        .collect())
}

async fn hydrate_generation_batch(
    db: &DatabaseConnection,
    rows: Vec<drawing_generations::Model>,
) -> Result<Vec<DrawingGeneration>> {
    if rows.is_empty() {
        return Ok(Vec::new());
    }

    let media_ids = rows
        .iter()
        .map(GenerationMediaIds::try_from)
        .collect::<Result<Vec<_>>>()?;
    let source_image_ids = collect_source_image_ids(&media_ids);
    let generation_ids = rows.iter().map(|row| row.id.clone()).collect();
    let (mut images_by_generation, images_by_id) =
        load_batch_images(db, generation_ids, source_image_ids).await?;

    let stored_file_ids = collect_stored_file_ids(&rows, &media_ids);
    let stored_files_by_id = load_batch_stored_files(db, stored_file_ids).await?;

    rows.into_iter()
        .zip(media_ids)
        .map(|(row, ids)| -> Result<DrawingGeneration> {
            let images = images_by_generation.remove(&row.id).unwrap_or_default();
            let reference_files = ids
                .reference_file_ids
                .iter()
                .map(|id| {
                    stored_files_by_id.get(id).cloned().ok_or_else(|| {
                        AQBotError::Validation(format!(
                            "Drawing generation {} references missing stored file {id}",
                            row.id
                        ))
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            let source_images = ids
                .source_image_ids
                .iter()
                .map(|id| {
                    images_by_id.get(id).cloned().ok_or_else(|| {
                        AQBotError::Validation(format!(
                            "Drawing generation {} references missing source image {id}",
                            row.id
                        ))
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            let mask_file = match row.mask_file_id.as_ref() {
                Some(id) => Some(stored_files_by_id.get(id).cloned().ok_or_else(|| {
                    AQBotError::Validation(format!(
                        "Drawing generation {} references missing mask file {id}",
                        row.id
                    ))
                })?),
                None => None,
            };
            Ok(generation_from_entity(
                row,
                images,
                reference_files,
                source_images,
                mask_file,
            ))
        })
        .collect()
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
    hydrate_generation_batch(db, rows).await
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
    use crate::entity::stored_files;
    use crate::repo::stored_file;
    use sea_orm::{DbBackend, MockDatabase};

    fn generation_model(
        id: &str,
        created_at: i64,
        reference_file_ids: &[&str],
        source_image_ids: &[&str],
        mask_file_id: Option<&str>,
    ) -> drawing_generations::Model {
        drawing_generations::Model {
            id: id.into(),
            parent_generation_id: None,
            provider_id: "provider-1".into(),
            key_id: "key-1".into(),
            model_id: "gpt-image-2".into(),
            api_kind: "image_api".into(),
            action: "generate".into(),
            prompt: format!("prompt-{id}"),
            parameters_json: "{}".into(),
            reference_file_ids_json: serde_json::to_string(reference_file_ids).unwrap(),
            source_image_ids_json: serde_json::to_string(source_image_ids).unwrap(),
            mask_file_id: mask_file_id.map(str::to_string),
            status: "succeeded".into(),
            error_message: None,
            response_id: None,
            usage_json: None,
            created_at,
            completed_at: Some(created_at + 1),
        }
    }

    fn image_model(id: &str, generation_id: &str, created_at: i64) -> drawing_images::Model {
        drawing_images::Model {
            id: id.into(),
            generation_id: generation_id.into(),
            stored_file_id: format!("file-{id}"),
            storage_path: format!("images/{id}.png"),
            mime_type: "image/png".into(),
            width: Some(1024),
            height: Some(1024),
            revised_prompt: None,
            created_at,
        }
    }

    fn stored_file_model(id: &str) -> stored_files::Model {
        stored_files::Model {
            id: id.into(),
            hash: format!("hash-{id}"),
            original_name: format!("{id}.png"),
            mime_type: "image/png".into(),
            size_bytes: 1024,
            storage_path: format!("images/{id}.png"),
            conversation_id: None,
            created_at: "2026-07-15T00:00:00Z".into(),
        }
    }

    #[tokio::test]
    async fn list_generations_batches_history_hydration() {
        let generations = vec![
            generation_model(
                "generation-new",
                200,
                &["reference-2", "reference-1"],
                &["source-2", "source-1"],
                Some("mask-1"),
            ),
            generation_model("generation-old", 100, &["reference-1"], &["source-1"], None),
        ];
        let all_images = vec![
            image_model("source-1", "source-generation", 10),
            image_model("source-2", "source-generation", 20),
            image_model("new-output-1", "generation-new", 210),
            image_model("new-output-2", "generation-new", 220),
            image_model("old-output", "generation-old", 110),
        ];
        let all_stored_files = vec![
            stored_file_model("reference-1"),
            stored_file_model("reference-2"),
            stored_file_model("mask-1"),
        ];

        let db = MockDatabase::new(DbBackend::Sqlite)
            .append_query_results([generations])
            .append_query_results([all_images])
            .append_query_results([all_stored_files])
            .into_connection();

        let fetched = list_generations(&db, 100, None).await.unwrap();
        let query_log = db.into_transaction_log();

        assert_eq!(query_log.len(), 3, "history hydration must stay O(1)");
        assert_eq!(
            fetched
                .iter()
                .map(|generation| generation.id.as_str())
                .collect::<Vec<_>>(),
            vec!["generation-new", "generation-old"]
        );

        let newest = &fetched[0];
        assert_eq!(
            newest
                .images
                .iter()
                .map(|image| image.id.as_str())
                .collect::<Vec<_>>(),
            vec!["new-output-1", "new-output-2"]
        );
        assert_eq!(
            newest
                .reference_files
                .iter()
                .map(|file| file.id.as_str())
                .collect::<Vec<_>>(),
            vec!["reference-2", "reference-1"]
        );
        assert_eq!(
            newest
                .source_images
                .iter()
                .map(|image| image.id.as_str())
                .collect::<Vec<_>>(),
            vec!["source-2", "source-1"]
        );
        assert_eq!(
            newest.mask_file.as_ref().map(|file| file.id.as_str()),
            Some("mask-1")
        );
        assert_eq!(fetched[1].images[0].id, "old-output");
        assert_eq!(fetched[1].reference_files[0].id, "reference-1");
        assert_eq!(fetched[1].source_images[0].id, "source-1");
        assert!(fetched[1].mask_file.is_none());
    }

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

    #[tokio::test]
    async fn batch_hydration_reports_corrupt_generation_media_json() {
        let h = create_test_pool().await.unwrap();
        let db = &h.conn;
        let generation = create_generation(
            db,
            NewDrawingGeneration {
                parent_generation_id: None,
                provider_id: "provider-1".into(),
                key_id: "key-1".into(),
                model_id: "gpt-image-2".into(),
                action: "generate".into(),
                prompt: "corrupt fixture".into(),
                parameters_json: "{}".into(),
                reference_file_ids_json: "[]".into(),
                source_image_ids_json: "[]".into(),
                mask_file_id: None,
            },
        )
        .await
        .unwrap();
        let model = drawing_generations::Entity::find_by_id(&generation.id)
            .one(db)
            .await
            .unwrap()
            .unwrap();
        let mut active: drawing_generations::ActiveModel = model.into();
        active.reference_file_ids_json = Set("not-json".to_string());
        active.update(db).await.unwrap();

        let error = list_generations(db, 100, None).await.unwrap_err();

        assert!(error.to_string().contains(&generation.id));
        assert!(error.to_string().contains("reference_file_ids_json"));
    }
}
