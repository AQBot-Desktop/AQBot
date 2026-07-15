use crate::AppState;
use aqbot_core::file_store::FileStore;
use aqbot_core::repo::drawing::{DrawingGeneration, DrawingImage, NewDrawingGeneration};
use aqbot_core::repo::stored_file::StoredFile;
use aqbot_core::types::{ProviderConfig, ProviderProxyConfig, ProviderType};
use aqbot_providers::openai_images::{
    ImageEditImageFormat, ImageEditRequest, ImageEditTransferMode, ImageGenerateRequest,
    ImageUpload, OpenAIImagesClient,
};
use aqbot_providers::{resolve_base_url_for_type, ProviderRequestContext};
use base64::Engine;
use image::GenericImageView;
use sea_orm::*;
use serde::{Deserialize, Serialize};
use tauri::State;

const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;
const MAX_REFERENCE_IMAGES: usize = 16;
const MAX_BATCH_IMAGES: u8 = 10;
const OPENAI_IMAGE_EDIT_PATH: &str = "/images/edits";
const OPENAI_JSON_IMAGE_PARAM_NAME: &str = "images";
const OPENAI_MULTIPART_IMAGE_PARAM_NAME: &str = "image[]";
const IMAGE_MODELS: &[&str] = &[
    "gpt-image-2",
    "gpt-image-1.5",
    "gpt-image-1",
    "gpt-image-1-mini",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrawingGenerateInput {
    pub provider_id: String,
    pub model_id: String,
    pub prompt: String,
    pub size: String,
    pub quality: String,
    pub output_format: String,
    pub background: Option<String>,
    pub output_compression: Option<u8>,
    pub n: u8,
    #[serde(default)]
    pub reference_image_mode: DrawingReferenceImageMode,
    #[serde(default)]
    pub reference_image_format: DrawingReferenceImageFormat,
    #[serde(default)]
    pub reference_image_param_name: String,
    #[serde(default)]
    pub reference_file_ids: Vec<String>,
    #[serde(default)]
    pub generation_api_path: String,
    #[serde(default)]
    pub edit_api_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrawingEditInput {
    pub provider_id: String,
    pub model_id: String,
    pub prompt: String,
    pub size: String,
    pub quality: String,
    pub output_format: String,
    pub background: Option<String>,
    pub output_compression: Option<u8>,
    pub n: u8,
    pub source_image_id: String,
    #[serde(default)]
    pub reference_image_mode: DrawingReferenceImageMode,
    #[serde(default)]
    pub reference_image_format: DrawingReferenceImageFormat,
    #[serde(default)]
    pub reference_image_param_name: String,
    #[serde(default)]
    pub reference_file_ids: Vec<String>,
    #[serde(default)]
    pub generation_api_path: String,
    #[serde(default)]
    pub edit_api_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrawingMaskEditInput {
    pub provider_id: String,
    pub model_id: String,
    pub prompt: String,
    pub size: String,
    pub quality: String,
    pub output_format: String,
    pub background: Option<String>,
    pub output_compression: Option<u8>,
    pub n: u8,
    pub source_image_id: String,
    pub mask_file_id: String,
    #[serde(default)]
    pub reference_image_mode: DrawingReferenceImageMode,
    #[serde(default)]
    pub reference_image_format: DrawingReferenceImageFormat,
    #[serde(default)]
    pub reference_image_param_name: String,
    #[serde(default)]
    pub reference_file_ids: Vec<String>,
    #[serde(default)]
    pub generation_api_path: String,
    #[serde(default)]
    pub edit_api_path: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DrawingReferenceImageMode {
    Multipart,
    Base64,
}

impl Default for DrawingReferenceImageMode {
    fn default() -> Self {
        Self::Base64
    }
}

impl From<DrawingReferenceImageMode> for ImageEditTransferMode {
    fn from(value: DrawingReferenceImageMode) -> Self {
        match value {
            DrawingReferenceImageMode::Multipart => ImageEditTransferMode::Multipart,
            DrawingReferenceImageMode::Base64 => ImageEditTransferMode::Base64,
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum DrawingReferenceImageFormat {
    Object,
    String,
}

impl Default for DrawingReferenceImageFormat {
    fn default() -> Self {
        Self::Object
    }
}

impl From<DrawingReferenceImageFormat> for ImageEditImageFormat {
    fn from(value: DrawingReferenceImageFormat) -> Self {
        match value {
            DrawingReferenceImageFormat::Object => ImageEditImageFormat::Object,
            DrawingReferenceImageFormat::String => ImageEditImageFormat::String,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrawingUploadInput {
    pub data: String,
    pub file_name: String,
    pub mime_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DrawingStoredFile {
    pub id: String,
    pub original_name: String,
    pub mime_type: String,
    pub size_bytes: i64,
    pub storage_path: String,
}

fn drawing_stored_file_from_repo(file: StoredFile) -> DrawingStoredFile {
    DrawingStoredFile {
        id: file.id,
        original_name: file.original_name,
        mime_type: file.mime_type,
        size_bytes: file.size_bytes,
        storage_path: file.storage_path,
    }
}

#[tauri::command]
pub async fn list_drawing_generations(
    state: State<'_, AppState>,
    limit: Option<u64>,
    cursor: Option<String>,
) -> Result<Vec<DrawingGeneration>, String> {
    let parsed_cursor = cursor.and_then(|value| value.parse::<i64>().ok());
    aqbot_core::repo::drawing::list_generations(&state.sea_db, limit.unwrap_or(30), parsed_cursor)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn upload_drawing_reference(
    state: State<'_, AppState>,
    input: DrawingUploadInput,
) -> Result<DrawingStoredFile, String> {
    if aqbot_core::inline_media::contains_inline_image_data(&input.file_name)
        || aqbot_core::inline_media::contains_inline_image_data(&input.mime_type)
    {
        return Err("Drawing file metadata contains inline image data".to_string());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&input.data)
        .map_err(|e| format!("Invalid base64: {}", e))?;
    validate_upload_image(&bytes, &input.mime_type)?;

    aqbot_core::storage_paths::ensure_documents_dirs()
        .map_err(|e| format!("Failed to ensure documents dirs: {}", e))?;
    save_drawing_reference_file(&state, &bytes, &input.file_name, &input.mime_type).await
}

#[tauri::command]
pub async fn generate_drawing_images(
    state: State<'_, AppState>,
    input: DrawingGenerateInput,
) -> Result<DrawingGeneration, String> {
    validate_common(
        &input.prompt,
        &input.model_id,
        &input.output_format,
        input.background.as_deref(),
        input.output_compression,
        input.n,
        input.reference_file_ids.len(),
        &input.size,
    )?;
    let (ctx, provider, key_id) = build_image_context(&state, &input.provider_id).await?;
    let edit_path = if input.reference_file_ids.is_empty() {
        None
    } else {
        resolve_edit_api_path(provider.provider_type.clone(), &input.edit_api_path)?
    };
    let action = if input.reference_file_ids.is_empty() {
        "generate"
    } else {
        "reference_generate"
    };
    let generation = create_running_generation(
        &state,
        &input.provider_id,
        &key_id,
        &input.model_id,
        action,
        &input.prompt,
        &input,
        &input.reference_file_ids,
        &[],
        None,
        None,
    )
    .await?;

    let generation_path = if input.generation_api_path.is_empty() {
        None
    } else {
        Some(input.generation_api_path.as_str())
    };
    let result = if input.reference_file_ids.is_empty() {
        OpenAIImagesClient::new()
            .generate(
                &ctx,
                ImageGenerateRequest {
                    model: input.model_id.clone(),
                    prompt: input.prompt.trim().to_string(),
                    n: input.n,
                    size: input.size.clone(),
                    quality: input.quality.clone(),
                    output_format: input.output_format.clone(),
                    background: input.background.clone(),
                    output_compression: input.output_compression,
                },
                generation_path,
            )
            .await
    } else {
        let uploads = load_reference_uploads(&state, &input.reference_file_ids).await?;
        let (transfer_mode, image_format, image_param_name) = resolve_image_edit_wire_options(
            &provider,
            input.reference_image_mode,
            input.reference_image_format,
            &input.reference_image_param_name,
        );
        OpenAIImagesClient::new()
            .edit(
                &ctx,
                ImageEditRequest {
                    model: input.model_id.clone(),
                    prompt: input.prompt.trim().to_string(),
                    n: input.n,
                    size: input.size.clone(),
                    quality: input.quality.clone(),
                    output_format: input.output_format.clone(),
                    background: input.background.clone(),
                    output_compression: input.output_compression,
                    transfer_mode,
                    image_format,
                    image_param_name,
                    images: uploads,
                    mask: None,
                },
                edit_path.as_deref(),
            )
            .await
    };

    persist_api_result(&state, generation, result, &input.output_format, &provider).await
}

#[tauri::command]
pub async fn edit_drawing_image(
    state: State<'_, AppState>,
    input: DrawingEditInput,
) -> Result<DrawingGeneration, String> {
    validate_common(
        &input.prompt,
        &input.model_id,
        &input.output_format,
        input.background.as_deref(),
        input.output_compression,
        input.n,
        input.reference_file_ids.len(),
        &input.size,
    )?;
    let (ctx, provider, key_id) = build_image_context(&state, &input.provider_id).await?;
    let edit_path = resolve_edit_api_path(provider.provider_type.clone(), &input.edit_api_path)?;
    let source = aqbot_core::repo::drawing::get_image(&state.sea_db, &input.source_image_id)
        .await
        .map_err(|e| e.to_string())?;
    let generation = create_running_generation(
        &state,
        &input.provider_id,
        &key_id,
        &input.model_id,
        "edit",
        &input.prompt,
        &input,
        &input.reference_file_ids,
        std::slice::from_ref(&input.source_image_id),
        Some(source.generation_id.clone()),
        None,
    )
    .await?;
    let mut uploads = vec![load_drawing_image_upload(&state, &source).await?];
    uploads.extend(load_reference_uploads(&state, &input.reference_file_ids).await?);
    let (transfer_mode, image_format, image_param_name) = resolve_image_edit_wire_options(
        &provider,
        input.reference_image_mode,
        input.reference_image_format,
        &input.reference_image_param_name,
    );
    let result = OpenAIImagesClient::new()
        .edit(
            &ctx,
            ImageEditRequest {
                model: input.model_id.clone(),
                prompt: input.prompt.trim().to_string(),
                n: input.n,
                size: input.size.clone(),
                quality: input.quality.clone(),
                output_format: input.output_format.clone(),
                background: input.background.clone(),
                output_compression: input.output_compression,
                transfer_mode,
                image_format,
                image_param_name,
                images: uploads,
                mask: None,
            },
            edit_path.as_deref(),
        )
        .await;

    persist_api_result(&state, generation, result, &input.output_format, &provider).await
}

#[tauri::command]
pub async fn edit_drawing_image_with_mask(
    state: State<'_, AppState>,
    input: DrawingMaskEditInput,
) -> Result<DrawingGeneration, String> {
    validate_common(
        &input.prompt,
        &input.model_id,
        &input.output_format,
        input.background.as_deref(),
        input.output_compression,
        input.n,
        input.reference_file_ids.len(),
        &input.size,
    )?;
    let (ctx, provider, key_id) = build_image_context(&state, &input.provider_id).await?;
    let edit_path = resolve_edit_api_path(provider.provider_type.clone(), &input.edit_api_path)?;
    let source = aqbot_core::repo::drawing::get_image(&state.sea_db, &input.source_image_id)
        .await
        .map_err(|e| e.to_string())?;
    let source_file =
        aqbot_core::repo::stored_file::get_stored_file(&state.sea_db, &source.stored_file_id)
            .await
            .map_err(|e| e.to_string())?;
    let mask_file =
        aqbot_core::repo::stored_file::get_stored_file(&state.sea_db, &input.mask_file_id)
            .await
            .map_err(|e| e.to_string())?;
    validate_mask_file(&source_file, &mask_file)?;

    let generation = create_running_generation(
        &state,
        &input.provider_id,
        &key_id,
        &input.model_id,
        "mask_edit",
        &input.prompt,
        &input,
        &input.reference_file_ids,
        std::slice::from_ref(&input.source_image_id),
        Some(source.generation_id.clone()),
        Some(input.mask_file_id.clone()),
    )
    .await?;
    let mut uploads = vec![load_drawing_image_upload(&state, &source).await?];
    uploads.extend(load_reference_uploads(&state, &input.reference_file_ids).await?);
    let mask = Some(load_stored_file_upload(&state, &mask_file).await?);
    let (transfer_mode, image_format, image_param_name) = resolve_image_edit_wire_options(
        &provider,
        input.reference_image_mode,
        input.reference_image_format,
        &input.reference_image_param_name,
    );
    let result = OpenAIImagesClient::new()
        .edit(
            &ctx,
            ImageEditRequest {
                model: input.model_id.clone(),
                prompt: input.prompt.trim().to_string(),
                n: input.n,
                size: input.size.clone(),
                quality: input.quality.clone(),
                output_format: input.output_format.clone(),
                background: input.background.clone(),
                output_compression: input.output_compression,
                transfer_mode,
                image_format,
                image_param_name,
                images: uploads,
                mask,
            },
            edit_path.as_deref(),
        )
        .await;

    persist_api_result(&state, generation, result, &input.output_format, &provider).await
}

#[tauri::command]
pub async fn delete_drawing_generation(
    state: State<'_, AppState>,
    id: String,
    delete_resources: Option<bool>,
) -> Result<(), String> {
    let file_store = FileStore::new();
    delete_drawing_generation_using(
        &state.sea_db,
        &file_store,
        &id,
        delete_resources.unwrap_or(false),
    )
    .await
}

async fn delete_drawing_generation_using(
    db: &sea_orm::DatabaseConnection,
    file_store: &FileStore,
    id: &str,
    delete_resources: bool,
) -> Result<(), String> {
    let _file_reference_guard = aqbot_core::repo::stored_file::lock_file_references().await;
    let txn = db.begin().await.map_err(|e| e.to_string())?;
    let operation = async {
        aqbot_core::entity::drawing_generations::Entity::find_by_id(id)
            .one(&txn)
            .await?
            .ok_or_else(|| {
                aqbot_core::error::AQBotError::NotFound(format!(
                    "DrawingGeneration {id}"
                ))
            })?;
        let images = aqbot_core::entity::drawing_images::Entity::find()
            .filter(aqbot_core::entity::drawing_images::Column::GenerationId.eq(id))
            .all(&txn)
            .await?;
        let dependencies = drawing_generation_dependencies(&txn, id, &images).await?;
        if !dependencies.is_empty() {
            return Err(aqbot_core::error::AQBotError::Validation(format!(
                "Drawing generation {id} is still referenced by {}; delete dependent generations first",
                dependencies.join(", ")
            )));
        }

        let mut stored_file_ids = images
            .iter()
            .map(|image| image.stored_file_id.clone())
            .collect::<Vec<_>>();
        stored_file_ids.sort();
        stored_file_ids.dedup();
        aqbot_core::entity::drawing_images::Entity::delete_many()
            .filter(aqbot_core::entity::drawing_images::Column::GenerationId.eq(id))
            .exec(&txn)
            .await?;
        let deleted = aqbot_core::entity::drawing_generations::Entity::delete_by_id(id)
            .exec(&txn)
            .await?;
        if deleted.rows_affected == 0 {
            return Err(aqbot_core::error::AQBotError::NotFound(format!(
                "DrawingGeneration {id}"
            )));
        }
        let resource_paths = if delete_resources {
            let candidates = stored_file_ids.into_iter().collect::<std::collections::HashSet<_>>();
            aqbot_core::repo::stored_file::delete_unreferenced_candidates(&txn, &candidates)
                .await?
        } else {
            Vec::new()
        };
        Ok::<_, aqbot_core::error::AQBotError>(resource_paths)
    }
    .await;
    let resource_paths = match operation {
        Ok(resource_paths) => resource_paths,
        Err(error) => {
            let rollback = txn.rollback().await.err();
            return Err(format!(
                "Failed to delete drawing generation {id}: {error}; rollback error: {}",
                rollback
                    .map(|error| error.to_string())
                    .unwrap_or_else(|| "none".to_string())
            ));
        }
    };
    txn.commit()
        .await
        .map_err(|error| format!("Failed to commit drawing generation deletion {id}: {error}"))?;

    if delete_resources {
        let mut paths = resource_paths;
        paths.sort();
        paths.dedup();
        let cleanup_errors = cleanup_created_drawing_paths(db, file_store, &paths).await;
        if !cleanup_errors.is_empty() {
            return Err(format!(
                "Drawing generation {id} was deleted but resource cleanup failed: {}",
                cleanup_errors.join(", ")
            ));
        }
    }
    Ok(())
}

async fn drawing_generation_dependencies(
    txn: &sea_orm::DatabaseTransaction,
    target_generation_id: &str,
    target_images: &[aqbot_core::entity::drawing_images::Model],
) -> aqbot_core::error::Result<Vec<String>> {
    let target_image_ids = target_images
        .iter()
        .map(|image| image.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let target_stored_file_ids = target_images
        .iter()
        .map(|image| image.stored_file_id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let generations = aqbot_core::entity::drawing_generations::Entity::find()
        .filter(aqbot_core::entity::drawing_generations::Column::Id.ne(target_generation_id))
        .all(txn)
        .await?;
    let other_images = aqbot_core::entity::drawing_images::Entity::find()
        .filter(aqbot_core::entity::drawing_images::Column::GenerationId.ne(target_generation_id))
        .all(txn)
        .await?;
    let mut dependencies = std::collections::BTreeSet::new();

    for generation in generations {
        if generation.parent_generation_id.as_deref() == Some(target_generation_id) {
            dependencies.insert(format!("{} (parent_generation_id)", generation.id));
        }
        let reference_file_ids = parse_drawing_dependency_ids(
            &generation.reference_file_ids_json,
            &generation.id,
            "reference_file_ids_json",
        )?;
        if reference_file_ids
            .iter()
            .any(|id| target_stored_file_ids.contains(id.as_str()))
        {
            dependencies.insert(format!("{} (reference_file_ids_json)", generation.id));
        }
        let source_image_ids = parse_drawing_dependency_ids(
            &generation.source_image_ids_json,
            &generation.id,
            "source_image_ids_json",
        )?;
        if source_image_ids
            .iter()
            .any(|id| target_image_ids.contains(id.as_str()))
        {
            dependencies.insert(format!("{} (source_image_ids_json)", generation.id));
        }
        if generation
            .mask_file_id
            .as_deref()
            .is_some_and(|id| target_stored_file_ids.contains(id))
        {
            dependencies.insert(format!("{} (mask_file_id)", generation.id));
        }
    }
    for image in other_images {
        if target_stored_file_ids.contains(image.stored_file_id.as_str()) {
            dependencies.insert(format!("{} (drawing_images)", image.generation_id));
        }
    }

    Ok(dependencies.into_iter().collect())
}

fn parse_drawing_dependency_ids(
    raw: &str,
    generation_id: &str,
    field: &str,
) -> aqbot_core::error::Result<Vec<String>> {
    serde_json::from_str(raw).map_err(|error| {
        aqbot_core::error::AQBotError::Validation(format!(
            "Drawing generation {generation_id} has invalid {field}: {error}"
        ))
    })
}

async fn build_image_context(
    state: &AppState,
    provider_id: &str,
) -> Result<(ProviderRequestContext, ProviderConfig, String), String> {
    let real_provider_id =
        aqbot_core::repo::provider::resolve_provider_id(&state.sea_db, provider_id)
            .await
            .map_err(|e| e.to_string())?;
    let provider = aqbot_core::repo::provider::get_provider(&state.sea_db, &real_provider_id)
        .await
        .map_err(|e| e.to_string())?;
    if !provider.enabled {
        return Err("Provider is disabled".to_string());
    }
    if !matches!(
        provider.provider_type,
        ProviderType::OpenAI | ProviderType::Custom
    ) {
        return Err("Drawing only supports OpenAI-compatible providers".to_string());
    }
    let key = aqbot_core::repo::provider::get_active_key(&state.sea_db, &real_provider_id)
        .await
        .map_err(|_| "Please configure an active OpenAI API key first".to_string())?;
    let decrypted = aqbot_core::crypto::decrypt_key(&key.key_encrypted, &state.master_key)
        .map_err(|e| e.to_string())?;
    let settings = aqbot_core::repo::settings::get_settings(&state.sea_db)
        .await
        .unwrap_or_default();
    let proxy = ProviderProxyConfig::resolve(&provider.proxy_config, &settings);
    let ctx = ProviderRequestContext {
        api_key: decrypted,
        key_id: key.id.clone(),
        provider_id: real_provider_id,
        base_url: Some(resolve_base_url_for_type(
            &provider.api_host,
            &provider.provider_type,
        )),
        api_path: provider.api_path.clone(),
        proxy_config: proxy,
        custom_headers: provider
            .custom_headers
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok()),
    };
    Ok((ctx, provider, key.id))
}

fn resolve_edit_api_path(
    provider_type: ProviderType,
    edit_api_path: &str,
) -> Result<Option<String>, String> {
    let trimmed = edit_api_path.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    if provider_type == ProviderType::OpenAI && trimmed != OPENAI_IMAGE_EDIT_PATH {
        return Err(format!(
            "OpenAI image edits must use {}; {} is not supported for the Image API",
            OPENAI_IMAGE_EDIT_PATH, trimmed
        ));
    }

    Ok(Some(trimmed.to_string()))
}

fn resolve_image_edit_wire_options(
    provider: &ProviderConfig,
    reference_image_mode: DrawingReferenceImageMode,
    reference_image_format: DrawingReferenceImageFormat,
    reference_image_param_name: &str,
) -> (ImageEditTransferMode, ImageEditImageFormat, String) {
    let transfer_mode = ImageEditTransferMode::from(reference_image_mode);
    if provider.provider_type == ProviderType::OpenAI {
        let image_param_name = match transfer_mode {
            ImageEditTransferMode::Multipart => OPENAI_MULTIPART_IMAGE_PARAM_NAME,
            ImageEditTransferMode::Base64 => OPENAI_JSON_IMAGE_PARAM_NAME,
        };
        return (
            transfer_mode,
            ImageEditImageFormat::Object,
            image_param_name.to_string(),
        );
    }

    (
        transfer_mode,
        ImageEditImageFormat::from(reference_image_format),
        reference_image_param_name.to_string(),
    )
}

async fn create_running_generation<T: Serialize>(
    state: &AppState,
    provider_id: &str,
    key_id: &str,
    model_id: &str,
    action: &str,
    prompt: &str,
    parameters: &T,
    reference_file_ids: &[String],
    source_image_ids: &[String],
    parent_generation_id: Option<String>,
    mask_file_id: Option<String>,
) -> Result<DrawingGeneration, String> {
    let parameters_json = serde_json::to_string(parameters).map_err(|e| e.to_string())?;
    let reference_file_ids_json =
        serde_json::to_string(reference_file_ids).map_err(|e| e.to_string())?;
    let source_image_ids_json =
        serde_json::to_string(source_image_ids).map_err(|e| e.to_string())?;
    let _file_reference_guard = aqbot_core::repo::stored_file::lock_file_references().await;
    validate_drawing_generation_references(
        &state.sea_db,
        reference_file_ids,
        source_image_ids,
        parent_generation_id.as_deref(),
        mask_file_id.as_deref(),
    )
    .await?;
    aqbot_core::repo::drawing::create_generation(
        &state.sea_db,
        NewDrawingGeneration {
            parent_generation_id,
            provider_id: provider_id.to_string(),
            key_id: key_id.to_string(),
            model_id: model_id.to_string(),
            action: action.to_string(),
            prompt: prompt.trim().to_string(),
            parameters_json,
            reference_file_ids_json,
            source_image_ids_json,
            mask_file_id,
        },
    )
    .await
    .map_err(|e| e.to_string())
}

async fn validate_drawing_generation_references(
    db: &sea_orm::DatabaseConnection,
    reference_file_ids: &[String],
    source_image_ids: &[String],
    parent_generation_id: Option<&str>,
    mask_file_id: Option<&str>,
) -> Result<(), String> {
    for file_id in reference_file_ids
        .iter()
        .map(String::as_str)
        .chain(mask_file_id)
    {
        aqbot_core::entity::stored_files::Entity::find_by_id(file_id)
            .one(db)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("StoredFile {file_id} not found"))?;
    }
    for image_id in source_image_ids {
        let image = aqbot_core::entity::drawing_images::Entity::find_by_id(image_id)
            .one(db)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("DrawingImage {image_id} not found"))?;
        aqbot_core::entity::stored_files::Entity::find_by_id(&image.stored_file_id)
            .one(db)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| {
                format!(
                    "StoredFile {} referenced by drawing image {image_id} not found",
                    image.stored_file_id
                )
            })?;
    }
    if let Some(parent_generation_id) = parent_generation_id {
        aqbot_core::entity::drawing_generations::Entity::find_by_id(parent_generation_id)
            .one(db)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| format!("DrawingGeneration {parent_generation_id} not found"))?;
    }
    Ok(())
}

async fn persist_api_result(
    state: &AppState,
    generation: DrawingGeneration,
    result: aqbot_core::error::Result<aqbot_providers::openai_images::ImageApiOutput>,
    output_format: &str,
    provider: &ProviderConfig,
) -> Result<DrawingGeneration, String> {
    match result {
        Ok(output) => {
            let _file_reference_guard = aqbot_core::repo::stored_file::lock_file_references().await;
            let mime_type = output_format_to_mime(output_format);
            let file_store = FileStore::new();
            let txn = state.sea_db.begin().await.map_err(|e| e.to_string())?;
            let mut created_paths = Vec::new();
            let response_id = output.response_id;
            let usage_json = output.usage_json;
            let operation = async {
                let generation_row =
                    aqbot_core::entity::drawing_generations::Entity::find_by_id(&generation.id)
                        .one(&txn)
                        .await?
                        .ok_or_else(|| {
                            aqbot_core::error::AQBotError::NotFound(format!(
                                "DrawingGeneration {}",
                                generation.id
                            ))
                        })?;
                let mut persisted_images = Vec::with_capacity(output.images.len());
                for (index, image) in output.images.into_iter().enumerate() {
                    let ext = output_format_to_extension(output_format);
                    let file_name = format!("drawing-{}-{}.{}", generation.id, index + 1, ext);
                    let saved = file_store.save_file(&image.bytes, &file_name, mime_type)?;
                    if saved.created {
                        created_paths.push(saved.storage_path.clone());
                    }
                    let stored_file_id = aqbot_core::utils::gen_id();
                    aqbot_core::entity::stored_files::ActiveModel {
                        id: Set(stored_file_id.clone()),
                        hash: Set(saved.hash),
                        original_name: Set(file_name.clone()),
                        mime_type: Set(mime_type.to_string()),
                        size_bytes: Set(saved.size_bytes),
                        storage_path: Set(saved.storage_path.clone()),
                        conversation_id: Set(None),
                        ..Default::default()
                    }
                    .insert(&txn)
                    .await?;
                    let dimensions = image_dimensions(&image.bytes).ok();
                    let image_id = aqbot_core::utils::gen_id();
                    let created_at = aqbot_core::utils::now_ts();
                    aqbot_core::entity::drawing_images::ActiveModel {
                        id: Set(image_id.clone()),
                        generation_id: Set(generation.id.clone()),
                        stored_file_id: Set(stored_file_id.clone()),
                        storage_path: Set(saved.storage_path.clone()),
                        mime_type: Set(mime_type.to_string()),
                        width: Set(dimensions.map(|d| d.0 as i32)),
                        height: Set(dimensions.map(|d| d.1 as i32)),
                        revised_prompt: Set(image.revised_prompt.clone()),
                        created_at: Set(created_at),
                    }
                    .insert(&txn)
                    .await?;
                    persisted_images.push(DrawingImage {
                        id: image_id,
                        generation_id: generation.id.clone(),
                        stored_file_id,
                        storage_path: saved.storage_path,
                        mime_type: mime_type.to_string(),
                        width: dimensions.map(|d| d.0 as i32),
                        height: dimensions.map(|d| d.1 as i32),
                        revised_prompt: image.revised_prompt,
                        created_at,
                    });
                }

                let completed_at = aqbot_core::utils::now_ts();
                let mut update: aqbot_core::entity::drawing_generations::ActiveModel =
                    generation_row.into();
                update.status = Set("succeeded".to_string());
                update.error_message = Set(None);
                update.response_id = Set(response_id.clone());
                update.usage_json = Set(usage_json.clone());
                update.completed_at = Set(Some(completed_at));
                update.update(&txn).await?;

                let mut persisted_generation = generation.clone();
                persisted_generation.status = "succeeded".to_string();
                persisted_generation.error_message = None;
                persisted_generation.response_id = response_id;
                persisted_generation.usage_json = usage_json;
                persisted_generation.completed_at = Some(completed_at);
                persisted_generation.images = persisted_images;
                Ok::<DrawingGeneration, aqbot_core::error::AQBotError>(persisted_generation)
            }
            .await;

            let persisted_generation = match operation {
                Ok(persisted_generation) => persisted_generation,
                Err(error) => {
                    let rollback_error = txn.rollback().await.err();
                    let cleanup_errors =
                        cleanup_created_drawing_paths(&state.sea_db, &file_store, &created_paths)
                            .await;
                    let failure = format!(
                        "Failed to persist drawing generation {}: {error}; rollback error: {}; cleanup errors: {}",
                        generation.id,
                        rollback_error
                            .map(|error| error.to_string())
                            .unwrap_or_else(|| "none".to_string()),
                        if cleanup_errors.is_empty() {
                            "none".to_string()
                        } else {
                            cleanup_errors.join(", ")
                        }
                    );
                    let _ = aqbot_core::repo::drawing::mark_generation_failed(
                        &state.sea_db,
                        &generation.id,
                        failure.clone(),
                    )
                    .await;
                    return Err(failure);
                }
            };
            if let Err(error) = txn.commit().await {
                let cleanup_errors =
                    cleanup_created_drawing_paths(&state.sea_db, &file_store, &created_paths).await;
                return Err(format!(
                    "Failed to commit drawing generation {}: {error}; cleanup errors: {}",
                    generation.id,
                    if cleanup_errors.is_empty() {
                        "none".to_string()
                    } else {
                        cleanup_errors.join(", ")
                    }
                ));
            }
            Ok(persisted_generation)
        }
        Err(err) => {
            let sanitized = sanitize_error(&err.to_string(), provider);
            let _ = aqbot_core::repo::drawing::mark_generation_failed(
                &state.sea_db,
                &generation.id,
                sanitized.clone(),
            )
            .await;
            Err(sanitized)
        }
    }
}

async fn cleanup_unregistered_drawing_file(
    db: &sea_orm::DatabaseConnection,
    file_store: &FileStore,
    saved: &aqbot_core::file_store::SavedFile,
) -> String {
    if !saved.created {
        return "none".to_string();
    }
    match aqbot_core::repo::stored_file::count_stored_files_with_storage_path(
        db,
        &saved.storage_path,
    )
    .await
    {
        Ok(0) => file_store
            .delete_file(&saved.storage_path)
            .err()
            .map(|error| error.to_string())
            .unwrap_or_else(|| "none".to_string()),
        Ok(_) => "none".to_string(),
        Err(error) => error.to_string(),
    }
}

async fn cleanup_created_drawing_paths(
    db: &sea_orm::DatabaseConnection,
    file_store: &FileStore,
    paths: &[String],
) -> Vec<String> {
    let mut unique_paths = paths.to_vec();
    unique_paths.sort();
    unique_paths.dedup();
    let mut errors = Vec::new();
    for path in unique_paths {
        match aqbot_core::repo::stored_file::count_stored_files_with_storage_path(db, &path).await {
            Ok(0) => {
                if let Err(error) = file_store.delete_file(&path) {
                    errors.push(format!("failed to delete {path}: {error}"));
                }
            }
            Ok(_) => {}
            Err(error) => errors.push(format!("failed to inspect {path}: {error}")),
        }
    }
    errors
}

async fn save_drawing_reference_file(
    state: &AppState,
    bytes: &[u8],
    file_name: &str,
    mime_type: &str,
) -> Result<DrawingStoredFile, String> {
    let _file_reference_guard = aqbot_core::repo::stored_file::lock_file_references().await;
    let file_store = FileStore::new();
    let saved = file_store
        .save_file(bytes, file_name, mime_type)
        .map_err(|e| e.to_string())?;

    let existing =
        match aqbot_core::repo::stored_file::find_by_hash(&state.sea_db, &saved.hash).await {
            Ok(existing) => existing,
            Err(error) => {
                let cleanup =
                    cleanup_unregistered_drawing_file(&state.sea_db, &file_store, &saved).await;
                return Err(format!(
                "Failed to inspect drawing file deduplication: {error}; cleanup error: {cleanup}"
            ));
            }
        };
    if let Some(existing) = existing {
        if existing.storage_path != saved.storage_path {
            let references =
                match aqbot_core::repo::stored_file::count_stored_files_with_storage_path(
                    &state.sea_db,
                    &saved.storage_path,
                )
                .await
                {
                    Ok(references) => references,
                    Err(error) => {
                        let cleanup =
                            cleanup_unregistered_drawing_file(&state.sea_db, &file_store, &saved)
                                .await;
                        return Err(format!(
                        "Failed to inspect duplicate drawing file {}: {error}; cleanup error: {cleanup}",
                        saved.storage_path
                    ));
                    }
                };
            if references == 0 {
                file_store
                    .delete_file(&saved.storage_path)
                    .map_err(|error| error.to_string())?;
            }
        }

        if existing.conversation_id.is_none() {
            return Ok(drawing_stored_file_from_repo(existing));
        }

        let id = aqbot_core::utils::gen_id();
        let stored = aqbot_core::repo::stored_file::create_stored_file(
            &state.sea_db,
            &id,
            &saved.hash,
            file_name,
            mime_type,
            saved.size_bytes,
            &existing.storage_path,
            None,
        )
        .await
        .map_err(|error| format!("Failed to register drawing reference: {error}"))?;
        return Ok(drawing_stored_file_from_repo(stored));
    }

    let id = aqbot_core::utils::gen_id();
    let stored = aqbot_core::repo::stored_file::create_stored_file(
        &state.sea_db,
        &id,
        &saved.hash,
        file_name,
        mime_type,
        saved.size_bytes,
        &saved.storage_path,
        None,
    )
    .await;
    let stored = match stored {
        Ok(stored) => stored,
        Err(error) => {
            let cleanup =
                cleanup_unregistered_drawing_file(&state.sea_db, &file_store, &saved).await;
            return Err(format!(
                "Failed to register drawing reference: {error}; cleanup error: {cleanup}"
            ));
        }
    };

    Ok(drawing_stored_file_from_repo(stored))
}

async fn load_reference_uploads(
    state: &AppState,
    file_ids: &[String],
) -> Result<Vec<ImageUpload>, String> {
    let mut uploads = Vec::with_capacity(file_ids.len());
    for file_id in file_ids {
        let file = aqbot_core::repo::stored_file::get_stored_file(&state.sea_db, file_id)
            .await
            .map_err(|e| e.to_string())?;
        uploads.push(load_stored_file_upload(state, &file).await?);
    }
    Ok(uploads)
}

async fn load_drawing_image_upload(
    state: &AppState,
    image: &DrawingImage,
) -> Result<ImageUpload, String> {
    let file = aqbot_core::repo::stored_file::get_stored_file(&state.sea_db, &image.stored_file_id)
        .await
        .map_err(|e| e.to_string())?;
    load_stored_file_upload(state, &file).await
}

async fn load_stored_file_upload(
    _state: &AppState,
    file: &aqbot_core::repo::stored_file::StoredFile,
) -> Result<ImageUpload, String> {
    let bytes = FileStore::new()
        .read_file(&file.storage_path)
        .map_err(|e| e.to_string())?;
    validate_upload_image(&bytes, &file.mime_type)?;
    Ok(ImageUpload {
        bytes,
        file_name: file.original_name.clone(),
        mime_type: file.mime_type.clone(),
    })
}

fn validate_common(
    prompt: &str,
    model_id: &str,
    output_format: &str,
    background: Option<&str>,
    output_compression: Option<u8>,
    n: u8,
    reference_count: usize,
    size: &str,
) -> Result<(), String> {
    if prompt.trim().is_empty() {
        return Err("Prompt must not be empty".to_string());
    }
    if !IMAGE_MODELS.contains(&model_id) {
        return Err(format!("Unsupported drawing model: {}", model_id));
    }
    if n == 0 || n > MAX_BATCH_IMAGES {
        return Err(format!(
            "Batch count must be between 1 and {}",
            MAX_BATCH_IMAGES
        ));
    }
    if reference_count > MAX_REFERENCE_IMAGES {
        return Err(format!(
            "Reference image count must not exceed {}",
            MAX_REFERENCE_IMAGES
        ));
    }
    if !matches!(output_format, "png" | "jpeg" | "webp") {
        return Err("Output format must be png, jpeg, or webp".to_string());
    }
    if output_compression.is_some() && !matches!(output_format, "jpeg" | "webp") {
        return Err("Compression is only supported for jpeg and webp".to_string());
    }
    if model_id == "gpt-image-2" && background == Some("transparent") {
        return Err("gpt-image-2 does not support transparent background".to_string());
    }
    validate_gpt_image_2_size(model_id, size)?;
    Ok(())
}

fn validate_gpt_image_2_size(model_id: &str, size: &str) -> Result<(), String> {
    if model_id != "gpt-image-2" || size == "auto" {
        return Ok(());
    }
    let Some((w, h)) = parse_size(size) else {
        return Err("Size must be auto or WIDTHxHEIGHT".to_string());
    };
    if w > 3840 || h > 3840 {
        return Err("gpt-image-2 size edge must not exceed 3840".to_string());
    }
    if w % 16 != 0 || h % 16 != 0 {
        return Err("gpt-image-2 size edges must be multiples of 16".to_string());
    }
    let (long, short) = if w >= h { (w, h) } else { (h, w) };
    if long > short * 3 {
        return Err("gpt-image-2 size ratio must not exceed 3:1".to_string());
    }
    let pixels = w * h;
    if !(655_360..=8_294_400).contains(&pixels) {
        return Err("gpt-image-2 total pixels are outside the supported range".to_string());
    }
    Ok(())
}

fn parse_size(size: &str) -> Option<(u32, u32)> {
    let (w, h) = size.split_once('x')?;
    Some((w.parse().ok()?, h.parse().ok()?))
}

fn validate_upload_image(bytes: &[u8], mime_type: &str) -> Result<(), String> {
    if bytes.len() > MAX_IMAGE_BYTES {
        return Err("Image must be smaller than 50MB".to_string());
    }
    if !matches!(
        mime_type,
        "image/png" | "image/jpeg" | "image/jpg" | "image/webp"
    ) {
        return Err("Only PNG, JPEG, and WebP images are supported".to_string());
    }
    image::load_from_memory(bytes).map_err(|e| format!("Invalid image: {}", e))?;
    Ok(())
}

fn validate_mask_file(
    source: &aqbot_core::repo::stored_file::StoredFile,
    mask: &aqbot_core::repo::stored_file::StoredFile,
) -> Result<(), String> {
    let store = FileStore::new();
    let source_bytes = store
        .read_file(&source.storage_path)
        .map_err(|e| e.to_string())?;
    let mask_bytes = store
        .read_file(&mask.storage_path)
        .map_err(|e| e.to_string())?;
    if mask_bytes.len() > MAX_IMAGE_BYTES {
        return Err("Mask must be smaller than 50MB".to_string());
    }
    if mask.mime_type != "image/png" {
        return Err("Mask must be a PNG image with an alpha channel".to_string());
    }
    let source_dim = image_dimensions(&source_bytes)?;
    let mask_image =
        image::load_from_memory(&mask_bytes).map_err(|e| format!("Invalid mask: {}", e))?;
    if source_dim != mask_image.dimensions() {
        return Err("Mask dimensions must match the source image".to_string());
    }
    if !has_alpha_channel(mask_image.color()) {
        return Err("Mask must contain an alpha channel".to_string());
    }
    Ok(())
}

fn image_dimensions(bytes: &[u8]) -> Result<(u32, u32), String> {
    let image = image::load_from_memory(bytes).map_err(|e| format!("Invalid image: {}", e))?;
    Ok(image.dimensions())
}

fn has_alpha_channel(color: image::ColorType) -> bool {
    matches!(
        color,
        image::ColorType::La8
            | image::ColorType::La16
            | image::ColorType::Rgba8
            | image::ColorType::Rgba16
            | image::ColorType::Rgba32F
    )
}

fn output_format_to_mime(format: &str) -> &'static str {
    match format {
        "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        _ => "image/png",
    }
}

fn output_format_to_extension(format: &str) -> &'static str {
    match format {
        "jpeg" => "jpg",
        "webp" => "webp",
        _ => "png",
    }
}

fn sanitize_error(raw: &str, provider: &ProviderConfig) -> String {
    let mut sanitized = raw.to_string();
    if let Some(headers) = &provider.custom_headers {
        sanitized = sanitized.replace(headers, "[redacted_headers]");
    }
    sanitized
}

#[cfg(test)]
mod tests {
    use super::*;
    use aqbot_core::repo::drawing::{NewDrawingGeneration, NewDrawingImage};
    use tempfile::tempdir;

    #[test]
    fn validates_batch_count_at_api_maximum() {
        assert!(validate_common(
            "prompt",
            "gpt-image-2",
            "png",
            Some("auto"),
            None,
            10,
            0,
            "1024x1024",
        )
        .is_ok());
        assert!(validate_common(
            "prompt",
            "gpt-image-2",
            "png",
            Some("auto"),
            None,
            11,
            0,
            "1024x1024",
        )
        .is_err());
    }

    #[test]
    fn rejects_transparent_background_for_gpt_image_2() {
        assert!(validate_common(
            "prompt",
            "gpt-image-2",
            "png",
            Some("transparent"),
            None,
            1,
            0,
            "1024x1024",
        )
        .is_err());
    }

    #[test]
    fn reference_image_mode_defaults_to_base64_for_older_payloads() {
        let input: DrawingGenerateInput = serde_json::from_value(serde_json::json!({
            "provider_id": "provider-1",
            "model_id": "gpt-image-2",
            "prompt": "prompt",
            "size": "auto",
            "quality": "auto",
            "output_format": "png",
            "background": "auto",
            "output_compression": null,
            "n": 1,
            "reference_file_ids": ["ref-1"]
        }))
        .expect("deserialize drawing input");

        assert_eq!(
            input.reference_image_mode,
            DrawingReferenceImageMode::Base64
        );
    }

    #[test]
    fn reference_image_mode_accepts_base64_payload_value() {
        let input: DrawingGenerateInput = serde_json::from_value(serde_json::json!({
            "provider_id": "provider-1",
            "model_id": "gpt-image-2",
            "prompt": "prompt",
            "size": "auto",
            "quality": "auto",
            "output_format": "png",
            "background": "auto",
            "output_compression": null,
            "n": 1,
            "reference_image_mode": "base64",
            "reference_file_ids": ["ref-1"]
        }))
        .expect("deserialize drawing input");

        assert_eq!(
            input.reference_image_mode,
            DrawingReferenceImageMode::Base64
        );
    }

    #[test]
    fn rejects_openai_responses_edit_api_path_for_image_edits() {
        let err = resolve_edit_api_path(ProviderType::OpenAI, "/responses")
            .expect_err("OpenAI image edits must not use Responses API paths");

        assert!(err.contains("/images/edits"));
        assert!(err.contains("/responses"));
    }

    #[test]
    fn custom_provider_can_keep_custom_edit_api_path() {
        assert_eq!(
            resolve_edit_api_path(ProviderType::Custom, "/v1/images/edits")
                .expect("custom providers may use custom image edit paths"),
            Some("/v1/images/edits".to_string())
        );
    }

    #[tokio::test]
    async fn refuses_both_deletion_modes_while_a_later_generation_uses_the_output() {
        let dir = tempdir().unwrap();
        let file_store = FileStore::with_root(dir.path().join("documents"));
        let saved = file_store
            .save_file(b"drawing-bytes", "drawing.png", "image/png")
            .unwrap();
        let db = aqbot_core::db::create_test_pool().await.unwrap();
        let stored = aqbot_core::repo::stored_file::create_stored_file(
            &db.conn,
            "stored-a",
            &saved.hash,
            "drawing.png",
            "image/png",
            saved.size_bytes,
            &saved.storage_path,
            None,
        )
        .await
        .unwrap();
        let generation_a = aqbot_core::repo::drawing::create_generation(
            &db.conn,
            NewDrawingGeneration {
                parent_generation_id: None,
                provider_id: "provider".into(),
                key_id: "key".into(),
                model_id: "gpt-image-2".into(),
                action: "generate".into(),
                prompt: "A".into(),
                parameters_json: "{}".into(),
                reference_file_ids_json: "[]".into(),
                source_image_ids_json: "[]".into(),
                mask_file_id: None,
            },
        )
        .await
        .unwrap();
        let image_a = aqbot_core::repo::drawing::add_image(
            &db.conn,
            NewDrawingImage {
                generation_id: generation_a.id.clone(),
                stored_file_id: stored.id.clone(),
                storage_path: stored.storage_path.clone(),
                mime_type: stored.mime_type.clone(),
                width: Some(1024),
                height: Some(1024),
                revised_prompt: None,
            },
        )
        .await
        .unwrap();
        let generation_b = aqbot_core::repo::drawing::create_generation(
            &db.conn,
            NewDrawingGeneration {
                parent_generation_id: None,
                provider_id: "provider".into(),
                key_id: "key".into(),
                model_id: "gpt-image-2".into(),
                action: "mask_edit".into(),
                prompt: "B".into(),
                parameters_json: "{}".into(),
                reference_file_ids_json: serde_json::to_string(&vec![stored.id.clone()]).unwrap(),
                source_image_ids_json: serde_json::to_string(&vec![image_a.id.clone()]).unwrap(),
                mask_file_id: Some(stored.id.clone()),
            },
        )
        .await
        .unwrap();

        for delete_resources in [false, true] {
            let error = delete_drawing_generation_using(
                &db.conn,
                &file_store,
                &generation_a.id,
                delete_resources,
            )
            .await
            .expect_err("a referenced drawing generation must not be deleted");
            assert!(error.contains(&generation_b.id));
        }

        let fetched_a = aqbot_core::repo::drawing::get_generation(&db.conn, &generation_a.id)
            .await
            .unwrap();
        assert_eq!(fetched_a.images.len(), 1);
        let fetched_b = aqbot_core::repo::drawing::get_generation(&db.conn, &generation_b.id)
            .await
            .unwrap();
        assert_eq!(fetched_b.reference_files.len(), 1);
        assert_eq!(fetched_b.source_images.len(), 1);
        assert_eq!(
            fetched_b.mask_file.as_ref().map(|file| file.id.as_str()),
            Some(stored.id.as_str())
        );
        assert!(file_store.read_file(&stored.storage_path).is_ok());
    }

    #[tokio::test]
    async fn deleting_drawing_resources_preserves_files_referenced_by_chat() {
        let dir = tempdir().unwrap();
        let file_store = FileStore::with_root(dir.path().join("documents"));
        let saved = file_store
            .save_file(b"shared-drawing", "shared.png", "image/png")
            .unwrap();
        let db = aqbot_core::db::create_test_pool().await.unwrap();
        let conversation = aqbot_core::repo::conversation::create_conversation(
            &db.conn,
            "Shared drawing",
            "model",
            "provider",
            None,
        )
        .await
        .unwrap();
        let stored = aqbot_core::repo::stored_file::create_stored_file(
            &db.conn,
            "shared-stored-file",
            &saved.hash,
            "shared.png",
            "image/png",
            saved.size_bytes,
            &saved.storage_path,
            Some(&conversation.id),
        )
        .await
        .unwrap();
        aqbot_core::repo::message::create_message(
            &db.conn,
            &conversation.id,
            aqbot_core::types::MessageRole::Assistant,
            &format!("![shared](aqbot-media://stored/{})", stored.id),
            &[],
            None,
            0,
        )
        .await
        .unwrap();
        let generation = aqbot_core::repo::drawing::create_generation(
            &db.conn,
            NewDrawingGeneration {
                parent_generation_id: None,
                provider_id: "provider".into(),
                key_id: "key".into(),
                model_id: "gpt-image-2".into(),
                action: "generate".into(),
                prompt: "shared".into(),
                parameters_json: "{}".into(),
                reference_file_ids_json: "[]".into(),
                source_image_ids_json: "[]".into(),
                mask_file_id: None,
            },
        )
        .await
        .unwrap();
        aqbot_core::repo::drawing::add_image(
            &db.conn,
            NewDrawingImage {
                generation_id: generation.id.clone(),
                stored_file_id: stored.id.clone(),
                storage_path: stored.storage_path.clone(),
                mime_type: stored.mime_type.clone(),
                width: None,
                height: None,
                revised_prompt: None,
            },
        )
        .await
        .unwrap();

        delete_drawing_generation_using(&db.conn, &file_store, &generation.id, true)
            .await
            .unwrap();

        assert!(aqbot_core::repo::drawing::get_generation(&db.conn, &generation.id)
            .await
            .is_err());
        assert!(aqbot_core::repo::stored_file::get_stored_file(&db.conn, &stored.id)
            .await
            .is_ok());
        assert!(file_store.read_file(&stored.storage_path).is_ok());
    }
}
