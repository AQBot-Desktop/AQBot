use crate::AppState;
use aqbot_core::file_store::FileStore;
use aqbot_core::repo::drawing::{DrawingGeneration, DrawingImage, NewDrawingGeneration};
use aqbot_core::repo::stored_file::StoredFile;
#[cfg(test)]
use aqbot_core::types::ProviderType;
use aqbot_core::types::{Model, ModelType, ProviderConfig, ProviderProxyConfig};
use aqbot_providers::image_adapters::{
    ImageAdapter, ImageAdapterConfig, ImageAdapterRegistry, ImageAdapterRequest,
    ImageModelDescriptor, ImageOperation, ImagePollResult, ImageSubmission, PendingImageSubmission,
};
use aqbot_providers::openai_images::ImageUpload;
use aqbot_providers::{resolve_base_url_for_type, ProviderRequestContext};
use base64::Engine;
use image::GenericImageView;
use sea_orm::prelude::Expr;
use sea_orm::*;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tauri::{Emitter, State};

const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;
const MAX_REFERENCE_IMAGES: usize = 16;
const MAX_BATCH_IMAGES: u8 = 10;
#[cfg(test)]
const OPENAI_IMAGE_EDIT_PATH: &str = "/images/edits";
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
    #[serde(default)]
    pub parameters: serde_json::Map<String, serde_json::Value>,
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
    #[serde(default)]
    pub parameters: serde_json::Map<String, serde_json::Value>,
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
    #[serde(default)]
    pub parameters: serde_json::Map<String, serde_json::Value>,
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

#[derive(Debug, Clone, Serialize)]
pub struct DrawingTarget {
    pub provider_id: String,
    pub provider_name: String,
    pub model_id: String,
    pub model_name: String,
    pub adapter_id: String,
    pub descriptor: ImageModelDescriptor,
}

#[derive(Debug, Clone, Serialize)]
pub struct DrawingTargetCatalog {
    pub targets: Vec<DrawingTarget>,
    pub unavailable_reasons: Vec<String>,
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
pub async fn cancel_drawing_generation(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<DrawingGeneration, String> {
    let generation = aqbot_core::repo::drawing::get_generation(&state.sea_db, &id)
        .await
        .map_err(|error| error.to_string())?;
    if generation.status != "running" {
        return Ok(generation);
    }
    aqbot_core::repo::drawing::mark_generation_cancelled(&state.sea_db, &id)
        .await
        .map_err(|error| error.to_string())?;
    let cancelled = aqbot_core::repo::drawing::get_generation(&state.sea_db, &id)
        .await
        .map_err(|error| error.to_string())?;
    let _ = app.emit("drawing-generation-updated", cancelled.clone());
    if let (Some(adapter_id), Some(remote_task_id)) = (
        generation.adapter_id.as_deref(),
        generation.remote_task_id.as_deref(),
    ) {
        try_cancel_remote_generation(&state, &generation, adapter_id, remote_task_id).await;
    }
    Ok(cancelled)
}

async fn try_cancel_remote_generation(
    state: &AppState,
    generation: &DrawingGeneration,
    adapter_id: &str,
    remote_task_id: &str,
) {
    let operation = operation_from_action(&generation.action);
    let Some(snapshot) = generation.adapter_config_snapshot.as_deref() else {
        return;
    };
    let Ok(config) = serde_json::from_str(snapshot) else {
        return;
    };
    let Ok(target) = build_image_context_from_snapshot(
        state,
        &generation.provider_id,
        &generation.model_id,
        operation,
        adapter_id,
        config,
    )
    .await
    else {
        return;
    };
    let pending = PendingImageSubmission {
        remote_task_id: remote_task_id.to_string(),
        remote_status: generation.remote_status.clone(),
        opaque_state: generation
            .opaque_state_json
            .as_deref()
            .and_then(|value| serde_json::from_str(value).ok()),
    };
    if let Err(error) = target
        .adapter
        .cancel(&target.ctx, &pending, &target.config)
        .await
    {
        tracing::warn!(
            generation_id = generation.id,
            adapter_id,
            error = %error,
            "Remote image cancellation failed; local task will still be cancelled"
        );
    }
}

fn operation_from_action(action: &str) -> ImageOperation {
    match action {
        "edit" | "reference_generate" => ImageOperation::Edit,
        "mask_edit" => ImageOperation::MaskEdit,
        _ => ImageOperation::Generate,
    }
}

pub async fn recover_drawing_generations(app: tauri::AppHandle, state: AppState) {
    let generations = match aqbot_core::repo::drawing::list_running_generations(&state.sea_db).await
    {
        Ok(generations) => generations,
        Err(error) => {
            tracing::warn!(error = %error, "Failed to inspect running drawing generations");
            return;
        }
    };
    for generation in generations {
        let Some(remote_task_id) = generation.remote_task_id.clone() else {
            fail_unrecoverable_generation(
                &app,
                &state,
                &generation.id,
                "The interrupted image request has no remote task id and cannot be resumed",
            )
            .await;
            continue;
        };
        let Some(adapter_id) = generation.adapter_id.clone() else {
            fail_unrecoverable_generation(
                &app,
                &state,
                &generation.id,
                "The interrupted image request has no adapter snapshot and cannot be resumed",
            )
            .await;
            continue;
        };
        let Some(snapshot) = generation.adapter_config_snapshot.as_deref() else {
            fail_unrecoverable_generation(
                &app,
                &state,
                &generation.id,
                "The interrupted image request has no adapter snapshot and cannot be resumed",
            )
            .await;
            continue;
        };
        let Ok(config) = serde_json::from_str::<ImageAdapterConfig>(snapshot) else {
            fail_unrecoverable_generation(
                &app,
                &state,
                &generation.id,
                "The image adapter snapshot is invalid and cannot be resumed",
            )
            .await;
            continue;
        };
        let Ok(target) = build_image_context_from_snapshot(
            &state,
            &generation.provider_id,
            &generation.model_id,
            operation_from_action(&generation.action),
            &adapter_id,
            config,
        )
        .await
        else {
            fail_unrecoverable_generation(
                &app,
                &state,
                &generation.id,
                "The image provider, model, or key is no longer available",
            )
            .await;
            continue;
        };
        let output_format = generation_output_format(&generation);
        let pending = PendingImageSubmission {
            remote_task_id,
            remote_status: generation.remote_status.clone(),
            opaque_state: generation
                .opaque_state_json
                .as_deref()
                .and_then(|value| serde_json::from_str(value).ok()),
        };
        let task_state = state.clone();
        let task_app = app.clone();
        let generation_id = generation.id.clone();
        tauri::async_runtime::spawn(async move {
            let outcome = poll_adapter_request(
                &task_state,
                PollExecution {
                    generation,
                    target,
                    output_format,
                },
                pending,
            )
            .await;
            emit_generation_outcome(&task_app, &task_state, &generation_id, outcome).await;
        });
    }
}

fn generation_output_format(generation: &DrawingGeneration) -> String {
    serde_json::from_str::<serde_json::Value>(&generation.parameters_json)
        .ok()
        .and_then(|value| {
            value
                .get("output_format")
                .and_then(serde_json::Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| "png".to_string())
}

async fn fail_unrecoverable_generation(
    app: &tauri::AppHandle,
    state: &AppState,
    generation_id: &str,
    message: &str,
) {
    let _ = aqbot_core::repo::drawing::mark_generation_failed(
        &state.sea_db,
        generation_id,
        message.to_string(),
    )
    .await;
    if let Ok(generation) =
        aqbot_core::repo::drawing::get_generation(&state.sea_db, generation_id).await
    {
        let _ = app.emit("drawing-generation-updated", generation);
    }
}

#[tauri::command]
pub async fn list_drawing_targets(
    state: State<'_, AppState>,
) -> Result<DrawingTargetCatalog, String> {
    let providers = aqbot_core::repo::provider::list_providers_merged(&state.sea_db)
        .await
        .map_err(|error| error.to_string())?;
    let mut targets = Vec::new();
    let mut unavailable_reasons = Vec::new();
    for provider in providers {
        if !provider.enabled {
            unavailable_reasons.push(format!("{}: provider is disabled", provider.name));
            continue;
        }
        for model in &provider.models {
            if let Some(target) = build_drawing_target(&provider, model) {
                targets.push(target);
            } else if model.model_type == ModelType::Image {
                unavailable_reasons.push(format!(
                    "{} / {}: model is disabled or its image adapter is unavailable",
                    provider.name, model.name
                ));
            }
        }
    }
    Ok(DrawingTargetCatalog {
        targets,
        unavailable_reasons,
    })
}

fn build_drawing_target(provider: &ProviderConfig, model: &Model) -> Option<DrawingTarget> {
    if !provider.enabled
        || !model.enabled
        || model.model_type != ModelType::Image
        || model.provider_id != provider.id
    {
        return None;
    }
    let config = parse_image_adapter_config(model).ok()?;
    let adapter = ImageAdapterRegistry::new().resolve(
        &provider.provider_type,
        &model.model_id,
        Some(&config),
    )?;
    let descriptor = adapter.descriptor(&model.model_id, &config);
    if descriptor.operations.is_empty() {
        return None;
    }
    Some(DrawingTarget {
        provider_id: provider.id.clone(),
        provider_name: provider.name.clone(),
        model_id: model.model_id.clone(),
        model_name: model.name.clone(),
        adapter_id: adapter.id().to_string(),
        descriptor,
    })
}

fn parse_image_adapter_config(model: &Model) -> Result<ImageAdapterConfig, String> {
    model
        .image_config
        .clone()
        .map(serde_json::from_value)
        .transpose()
        .map_err(|error| format!("Invalid image adapter configuration: {error}"))
        .map(|config| config.unwrap_or_default())
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
pub async fn create_drawing_generation(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    operation: ImageOperation,
    input: serde_json::Value,
) -> Result<DrawingGeneration, String> {
    match operation {
        ImageOperation::Generate => {
            let input = serde_json::from_value(input).map_err(|error| error.to_string())?;
            generate_drawing_images(app, state, input).await
        }
        ImageOperation::Edit => {
            let input = serde_json::from_value(input).map_err(|error| error.to_string())?;
            edit_drawing_image(app, state, input).await
        }
        ImageOperation::MaskEdit => {
            let input = serde_json::from_value(input).map_err(|error| error.to_string())?;
            edit_drawing_image_with_mask(app, state, input).await
        }
    }
}

#[tauri::command]
pub async fn generate_drawing_images(
    app: tauri::AppHandle,
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
    let operation = if input.reference_file_ids.is_empty() {
        ImageOperation::Generate
    } else {
        ImageOperation::Edit
    };
    let mut target =
        build_image_context(&state, &input.provider_id, &input.model_id, operation).await?;
    validate_target_limits(&target, input.n, input.reference_file_ids.len())?;
    apply_legacy_image_paths(
        &mut target,
        &input.generation_api_path,
        &input.edit_api_path,
    );
    let action = if input.reference_file_ids.is_empty() {
        "generate"
    } else {
        "reference_generate"
    };
    let generation = create_running_generation(
        &state,
        &input.provider_id,
        &target.key_id,
        &input.model_id,
        target.adapter.id(),
        &target.config,
        action,
        &input.prompt,
        &input,
        &input.reference_file_ids,
        &[],
        None,
        None,
    )
    .await?;

    let returned_generation = generation.clone();
    let generation_id = generation.id.clone();
    let task_state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        let outcome = async {
            let uploads = if input.reference_file_ids.is_empty() {
                Vec::new()
            } else {
                load_reference_uploads(&task_state, &input.reference_file_ids).await?
            };
            let request = adapter_request_from_generate(&input, operation, uploads);
            execute_adapter_request(
                &task_state,
                AdapterExecution {
                    generation,
                    target,
                    request,
                    output_format: input.output_format,
                },
            )
            .await
        }
        .await;
        emit_generation_outcome(&app, &task_state, &generation_id, outcome).await;
    });
    Ok(returned_generation)
}

#[tauri::command]
pub async fn edit_drawing_image(
    app: tauri::AppHandle,
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
    let mut target = build_image_context(
        &state,
        &input.provider_id,
        &input.model_id,
        ImageOperation::Edit,
    )
    .await?;
    validate_target_limits(&target, input.n, input.reference_file_ids.len() + 1)?;
    apply_legacy_image_paths(
        &mut target,
        &input.generation_api_path,
        &input.edit_api_path,
    );
    let source = aqbot_core::repo::drawing::get_image(&state.sea_db, &input.source_image_id)
        .await
        .map_err(|e| e.to_string())?;
    let generation = create_running_generation(
        &state,
        &input.provider_id,
        &target.key_id,
        &input.model_id,
        target.adapter.id(),
        &target.config,
        "edit",
        &input.prompt,
        &input,
        &input.reference_file_ids,
        std::slice::from_ref(&input.source_image_id),
        Some(source.generation_id.clone()),
        None,
    )
    .await?;
    let returned_generation = generation.clone();
    let generation_id = generation.id.clone();
    let task_state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        let outcome = async {
            let mut uploads = vec![load_drawing_image_upload(&task_state, &source).await?];
            uploads.extend(load_reference_uploads(&task_state, &input.reference_file_ids).await?);
            let request = adapter_request_from_edit(&input, ImageOperation::Edit, uploads, None);
            execute_adapter_request(
                &task_state,
                AdapterExecution {
                    generation,
                    target,
                    request,
                    output_format: input.output_format,
                },
            )
            .await
        }
        .await;
        emit_generation_outcome(&app, &task_state, &generation_id, outcome).await;
    });
    Ok(returned_generation)
}

#[tauri::command]
pub async fn edit_drawing_image_with_mask(
    app: tauri::AppHandle,
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
    let mut target = build_image_context(
        &state,
        &input.provider_id,
        &input.model_id,
        ImageOperation::MaskEdit,
    )
    .await?;
    validate_target_limits(&target, input.n, input.reference_file_ids.len() + 1)?;
    apply_legacy_image_paths(
        &mut target,
        &input.generation_api_path,
        &input.edit_api_path,
    );
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
        &target.key_id,
        &input.model_id,
        target.adapter.id(),
        &target.config,
        "mask_edit",
        &input.prompt,
        &input,
        &input.reference_file_ids,
        std::slice::from_ref(&input.source_image_id),
        Some(source.generation_id.clone()),
        Some(input.mask_file_id.clone()),
    )
    .await?;
    let returned_generation = generation.clone();
    let generation_id = generation.id.clone();
    let task_state = state.inner().clone();
    tauri::async_runtime::spawn(async move {
        let outcome = async {
            let mut uploads = vec![load_drawing_image_upload(&task_state, &source).await?];
            uploads.extend(load_reference_uploads(&task_state, &input.reference_file_ids).await?);
            let mask = Some(load_stored_file_upload(&task_state, &mask_file).await?);
            let request = adapter_request_from_mask_edit(&input, uploads, mask);
            execute_adapter_request(
                &task_state,
                AdapterExecution {
                    generation,
                    target,
                    request,
                    output_format: input.output_format,
                },
            )
            .await
        }
        .await;
        emit_generation_outcome(&app, &task_state, &generation_id, outcome).await;
    });
    Ok(returned_generation)
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

struct ResolvedImageTarget {
    ctx: ProviderRequestContext,
    provider: ProviderConfig,
    key_id: String,
    adapter: Arc<dyn ImageAdapter>,
    config: ImageAdapterConfig,
}

struct AdapterExecution {
    generation: DrawingGeneration,
    target: ResolvedImageTarget,
    request: ImageAdapterRequest,
    output_format: String,
}

struct PollExecution {
    generation: DrawingGeneration,
    target: ResolvedImageTarget,
    output_format: String,
}

async fn build_image_context(
    state: &AppState,
    provider_id: &str,
    model_id: &str,
    operation: ImageOperation,
) -> Result<ResolvedImageTarget, String> {
    let (provider, model, ctx, key_id) =
        load_image_target_base(state, provider_id, model_id).await?;
    let mut config = parse_image_adapter_config(&model)?;
    if config.endpoint.is_none()
        && provider
            .api_path
            .as_deref()
            .is_some_and(|path| path.contains("images"))
    {
        config.endpoint = provider.api_path.clone();
    }
    let adapter = ImageAdapterRegistry::new()
        .resolve(&provider.provider_type, model_id, Some(&config))
        .ok_or_else(|| "The selected image adapter is unavailable".to_string())?;
    build_resolved_image_target(provider, model, ctx, key_id, adapter, config, operation)
}

async fn build_image_context_from_snapshot(
    state: &AppState,
    provider_id: &str,
    model_id: &str,
    operation: ImageOperation,
    adapter_id: &str,
    config: ImageAdapterConfig,
) -> Result<ResolvedImageTarget, String> {
    let (provider, model, ctx, key_id) =
        load_image_target_base(state, provider_id, model_id).await?;
    let adapter = ImageAdapterRegistry::new()
        .get(adapter_id)
        .ok_or_else(|| "The saved image adapter is no longer available".to_string())?;
    build_resolved_image_target(provider, model, ctx, key_id, adapter, config, operation)
}

async fn load_image_target_base(
    state: &AppState,
    provider_id: &str,
    model_id: &str,
) -> Result<(ProviderConfig, Model, ProviderRequestContext, String), String> {
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
    let model = aqbot_core::repo::provider::get_model(&state.sea_db, &real_provider_id, model_id)
        .await
        .map_err(|_| "The selected image model does not belong to this provider".to_string())?;
    if !model.enabled || model.model_type != ModelType::Image || model.provider_id != provider.id {
        return Err("The selected model is disabled or is not an Image model".to_string());
    }
    let key = aqbot_core::repo::provider::get_active_key(&state.sea_db, &real_provider_id)
        .await
        .map_err(|_| "Please configure an active API key first".to_string())?;
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
    Ok((provider, model, ctx, key.id))
}

fn build_resolved_image_target(
    provider: ProviderConfig,
    model: Model,
    ctx: ProviderRequestContext,
    key_id: String,
    adapter: Arc<dyn ImageAdapter>,
    config: ImageAdapterConfig,
    operation: ImageOperation,
) -> Result<ResolvedImageTarget, String> {
    let descriptor = adapter.descriptor(&model.model_id, &config);
    if !descriptor.operations.contains(&operation) {
        return Err(format!(
            "{} does not support the requested image operation",
            adapter.id()
        ));
    }
    Ok(ResolvedImageTarget {
        ctx,
        provider,
        key_id,
        adapter,
        config,
    })
}

#[cfg(test)]
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

fn apply_legacy_image_paths(
    target: &mut ResolvedImageTarget,
    generation_path: &str,
    edit_path: &str,
) {
    if matches!(target.adapter.id(), "gemini_images" | "generic_json") {
        return;
    }
    if target.config.endpoint.is_none() && !generation_path.trim().is_empty() {
        target.config.endpoint = Some(generation_path.trim().to_string());
    }
    if target.config.edit_endpoint.is_none() && !edit_path.trim().is_empty() {
        target.config.edit_endpoint = Some(edit_path.trim().to_string());
    }
}

fn validate_target_limits(
    target: &ResolvedImageTarget,
    batch_size: u8,
    reference_count: usize,
) -> Result<(), String> {
    let descriptor = target.adapter.descriptor("", &target.config);
    if batch_size > descriptor.max_batch_size {
        return Err(format!(
            "{} supports at most {} image(s) per request",
            target.adapter.id(),
            descriptor.max_batch_size
        ));
    }
    if reference_count > descriptor.max_reference_images as usize {
        return Err(format!(
            "{} supports at most {} reference image(s)",
            target.adapter.id(),
            descriptor.max_reference_images
        ));
    }
    Ok(())
}

fn adapter_request_from_generate(
    input: &DrawingGenerateInput,
    operation: ImageOperation,
    images: Vec<ImageUpload>,
) -> ImageAdapterRequest {
    let mut parameters = input.parameters.clone();
    parameters.insert(
        "_aqbot_reference_mode".into(),
        serde_json::json!(input.reference_image_mode),
    );
    parameters.insert(
        "_aqbot_reference_format".into(),
        serde_json::json!(input.reference_image_format),
    );
    parameters.insert(
        "_aqbot_reference_param".into(),
        input.reference_image_param_name.clone().into(),
    );
    ImageAdapterRequest {
        operation,
        model: input.model_id.clone(),
        prompt: input.prompt.trim().to_string(),
        n: input.n,
        size: input.size.clone(),
        quality: input.quality.clone(),
        output_format: input.output_format.clone(),
        background: input.background.clone(),
        output_compression: input.output_compression,
        images,
        mask: None,
        parameters,
    }
}

fn adapter_request_from_edit(
    input: &DrawingEditInput,
    operation: ImageOperation,
    images: Vec<ImageUpload>,
    mask: Option<ImageUpload>,
) -> ImageAdapterRequest {
    let mut parameters = input.parameters.clone();
    parameters.insert(
        "_aqbot_reference_mode".into(),
        serde_json::json!(input.reference_image_mode),
    );
    parameters.insert(
        "_aqbot_reference_format".into(),
        serde_json::json!(input.reference_image_format),
    );
    parameters.insert(
        "_aqbot_reference_param".into(),
        input.reference_image_param_name.clone().into(),
    );
    ImageAdapterRequest {
        operation,
        model: input.model_id.clone(),
        prompt: input.prompt.trim().to_string(),
        n: input.n,
        size: input.size.clone(),
        quality: input.quality.clone(),
        output_format: input.output_format.clone(),
        background: input.background.clone(),
        output_compression: input.output_compression,
        images,
        mask,
        parameters,
    }
}

fn adapter_request_from_mask_edit(
    input: &DrawingMaskEditInput,
    images: Vec<ImageUpload>,
    mask: Option<ImageUpload>,
) -> ImageAdapterRequest {
    let mut parameters = input.parameters.clone();
    parameters.insert(
        "_aqbot_reference_mode".into(),
        serde_json::json!(input.reference_image_mode),
    );
    parameters.insert(
        "_aqbot_reference_format".into(),
        serde_json::json!(input.reference_image_format),
    );
    parameters.insert(
        "_aqbot_reference_param".into(),
        input.reference_image_param_name.clone().into(),
    );
    ImageAdapterRequest {
        operation: ImageOperation::MaskEdit,
        model: input.model_id.clone(),
        prompt: input.prompt.trim().to_string(),
        n: input.n,
        size: input.size.clone(),
        quality: input.quality.clone(),
        output_format: input.output_format.clone(),
        background: input.background.clone(),
        output_compression: input.output_compression,
        images,
        mask,
        parameters,
    }
}

async fn create_running_generation<T: Serialize>(
    state: &AppState,
    provider_id: &str,
    key_id: &str,
    model_id: &str,
    adapter_id: &str,
    adapter_config: &ImageAdapterConfig,
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
    let generation = aqbot_core::repo::drawing::create_generation(
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
            adapter_id: Some(adapter_id.to_string()),
            adapter_config_snapshot: Some(
                serde_json::to_string(adapter_config).map_err(|error| error.to_string())?,
            ),
            deadline_at: Some(
                aqbot_core::utils::now_ts() + adapter_config.normalized_timeout() as i64,
            ),
        },
    )
    .await
    .map_err(|e| e.to_string())?;
    tracing::info!(
        generation_id = generation.id,
        provider_id,
        model_id,
        adapter_id,
        action,
        "Created drawing generation"
    );
    Ok(generation)
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
                if generation_row.status != "running" {
                    return Err(aqbot_core::error::AQBotError::Validation(
                        "Drawing generation is no longer running".into(),
                    ));
                }
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
                let update = aqbot_core::entity::drawing_generations::Entity::update_many()
                    .col_expr(
                        aqbot_core::entity::drawing_generations::Column::Status,
                        Expr::value("succeeded"),
                    )
                    .col_expr(
                        aqbot_core::entity::drawing_generations::Column::ErrorMessage,
                        Expr::value(Option::<String>::None),
                    )
                    .col_expr(
                        aqbot_core::entity::drawing_generations::Column::ResponseId,
                        Expr::value(response_id.clone()),
                    )
                    .col_expr(
                        aqbot_core::entity::drawing_generations::Column::UsageJson,
                        Expr::value(usage_json.clone()),
                    )
                    .col_expr(
                        aqbot_core::entity::drawing_generations::Column::CompletedAt,
                        Expr::value(Some(completed_at)),
                    )
                    .filter(aqbot_core::entity::drawing_generations::Column::Id.eq(&generation.id))
                    .filter(aqbot_core::entity::drawing_generations::Column::Status.eq("running"))
                    .exec(&txn)
                    .await?;
                if update.rows_affected == 0 {
                    return Err(aqbot_core::error::AQBotError::Validation(
                        "Drawing generation is no longer running".into(),
                    ));
                }

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

async fn emit_generation_outcome(
    app: &tauri::AppHandle,
    state: &AppState,
    generation_id: &str,
    outcome: Result<DrawingGeneration, String>,
) {
    if let Err(error) = outcome {
        let cancelled = aqbot_core::repo::drawing::get_generation(&state.sea_db, generation_id)
            .await
            .is_ok_and(|generation| matches!(generation.status.as_str(), "cancelled" | "stopped"));
        if !cancelled {
            let _ = aqbot_core::repo::drawing::mark_generation_failed(
                &state.sea_db,
                generation_id,
                error,
            )
            .await;
        }
    }
    match aqbot_core::repo::drawing::get_generation(&state.sea_db, generation_id).await {
        Ok(generation) => {
            let _ = app.emit("drawing-generation-updated", generation);
        }
        Err(error) => tracing::warn!(
            generation_id,
            error = %error,
            "Failed to emit drawing generation update"
        ),
    }
}

async fn execute_adapter_request(
    state: &AppState,
    execution: AdapterExecution,
) -> Result<DrawingGeneration, String> {
    let AdapterExecution {
        generation,
        target,
        mut request,
        output_format,
    } = execution;
    if target.provider.provider_type == aqbot_core::types::ProviderType::OpenAI {
        request
            .parameters
            .insert("_aqbot_reference_mode".into(), serde_json::json!("base64"));
        request.parameters.insert(
            "_aqbot_reference_format".into(),
            serde_json::json!("object"),
        );
        request
            .parameters
            .insert("_aqbot_reference_param".into(), serde_json::json!("images"));
    }
    let result = target
        .adapter
        .submit(&target.ctx, request, &target.config)
        .await;
    let current = aqbot_core::repo::drawing::get_generation(&state.sea_db, &generation.id)
        .await
        .map_err(|error| error.to_string())?;
    if matches!(current.status.as_str(), "cancelled" | "stopped") {
        return Ok(current);
    }
    match result {
        Ok(ImageSubmission::Completed(output)) => {
            persist_api_result(
                state,
                generation,
                Ok(output),
                &output_format,
                &target.provider,
            )
            .await
        }
        Ok(ImageSubmission::Pending(pending)) => {
            persist_pending(state, &generation.id, &pending).await?;
            poll_adapter_request(
                state,
                PollExecution {
                    generation,
                    target,
                    output_format,
                },
                pending,
            )
            .await
        }
        Err(error) => Err(sanitize_error(&error.to_string(), &target.provider)),
    }
}

async fn persist_pending(
    state: &AppState,
    generation_id: &str,
    pending: &PendingImageSubmission,
) -> Result<(), String> {
    tracing::info!(
        generation_id,
        remote_status = pending.remote_status.as_deref().unwrap_or("pending"),
        "Drawing generation is pending remotely"
    );
    aqbot_core::repo::drawing::mark_generation_pending(
        &state.sea_db,
        generation_id,
        pending.remote_task_id.clone(),
        pending.remote_status.clone(),
        pending
            .opaque_state
            .as_ref()
            .map(serde_json::Value::to_string),
    )
    .await
    .map_err(|error| error.to_string())
}

async fn poll_adapter_request(
    state: &AppState,
    execution: PollExecution,
    mut pending: PendingImageSubmission,
) -> Result<DrawingGeneration, String> {
    let generation_id = execution.generation.id.clone();
    let deadline = execution
        .generation
        .deadline_at
        .unwrap_or_else(|| aqbot_core::utils::now_ts() + 60 * 60);
    let mut poll_count = execution.generation.poll_count;
    let mut consecutive_errors = execution.generation.consecutive_errors;
    loop {
        if aqbot_core::utils::now_ts() >= deadline {
            return Err("Image generation timed out".into());
        }
        let current = aqbot_core::repo::drawing::get_generation(&state.sea_db, &generation_id)
            .await
            .map_err(|error| error.to_string())?;
        if matches!(current.status.as_str(), "cancelled" | "stopped") {
            return Ok(current);
        }
        let delay = poll_delay(&execution.target.config, consecutive_errors);
        tokio::time::sleep(std::time::Duration::from_secs(delay)).await;
        let current = aqbot_core::repo::drawing::get_generation(&state.sea_db, &generation_id)
            .await
            .map_err(|error| error.to_string())?;
        if matches!(current.status.as_str(), "cancelled" | "stopped") {
            return Ok(current);
        }
        poll_count += 1;
        match execution
            .target
            .adapter
            .poll(&execution.target.ctx, &pending, &execution.target.config)
            .await
        {
            Ok(ImagePollResult::Completed(output)) => {
                return persist_api_result(
                    state,
                    execution.generation,
                    Ok(output),
                    &execution.output_format,
                    &execution.target.provider,
                )
                .await;
            }
            Ok(ImagePollResult::Pending(next)) => {
                consecutive_errors = 0;
                pending = next;
                update_poll_state(
                    state,
                    &generation_id,
                    &pending,
                    poll_count,
                    consecutive_errors,
                )
                .await?;
            }
            Ok(ImagePollResult::Failed(error)) => return Err(error),
            Err(error) => {
                consecutive_errors += 1;
                update_poll_state(
                    state,
                    &generation_id,
                    &pending,
                    poll_count,
                    consecutive_errors,
                )
                .await?;
                if consecutive_errors >= 5 {
                    return Err(format!("Image polling failed after 5 attempts: {error}"));
                }
            }
        }
    }
}

async fn update_poll_state(
    state: &AppState,
    generation_id: &str,
    pending: &PendingImageSubmission,
    poll_count: i32,
    consecutive_errors: i32,
) -> Result<(), String> {
    tracing::debug!(
        generation_id,
        remote_status = pending.remote_status.as_deref().unwrap_or("pending"),
        poll_count,
        consecutive_errors,
        "Updated drawing generation polling state"
    );
    aqbot_core::repo::drawing::update_generation_poll(
        &state.sea_db,
        generation_id,
        pending.remote_status.clone(),
        pending
            .opaque_state
            .as_ref()
            .map(serde_json::Value::to_string),
        poll_count,
        consecutive_errors,
    )
    .await
    .map_err(|error| error.to_string())
}

fn poll_delay(config: &ImageAdapterConfig, consecutive_errors: i32) -> u64 {
    let base = config.normalized_poll_interval();
    if consecutive_errors <= 0 {
        return base;
    }
    base.saturating_mul(1_u64 << consecutive_errors.min(4))
        .min(30)
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
    if model_id.trim().is_empty() {
        return Err("Drawing model must not be empty".to_string());
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
        if let Ok(values) =
            serde_json::from_str::<std::collections::HashMap<String, String>>(headers)
        {
            for value in values.values().filter(|value| !value.is_empty()) {
                sanitized = sanitized.replace(value, "[REDACTED]");
            }
        }
    }
    sanitized
}

#[cfg(test)]
mod tests {
    use super::*;
    use aqbot_core::repo::drawing::{NewDrawingGeneration, NewDrawingImage};
    use tempfile::tempdir;

    #[test]
    fn custom_grok_image_model_builds_an_xai_drawing_target() {
        let provider = ProviderConfig {
            id: "custom-xai".into(),
            name: "Custom xAI".into(),
            provider_type: ProviderType::Custom,
            api_host: "https://api.x.ai".into(),
            api_path: None,
            enabled: true,
            models: vec![Model {
                provider_id: "custom-xai".into(),
                model_id: "grok-imagine-image".into(),
                name: "Grok Imagine".into(),
                group_name: None,
                model_type: ModelType::Image,
                capabilities: Vec::new(),
                max_tokens: None,
                enabled: true,
                param_overrides: None,
                image_config: None,
            }],
            keys: Vec::new(),
            proxy_config: None,
            custom_headers: None,
            icon: None,
            builtin_id: None,
            sort_order: 0,
            created_at: 0,
            updated_at: 0,
        };

        let target = build_drawing_target(&provider, &provider.models[0])
            .expect("custom grok image model should be available");
        assert_eq!(target.adapter_id, "xai_images");
        assert_eq!(target.model_id, "grok-imagine-image");
    }

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
    fn common_validation_accepts_dynamic_image_model_ids() {
        assert!(validate_common(
            "prompt",
            "grok-imagine-image",
            "png",
            Some("auto"),
            None,
            1,
            0,
            "1024x1024",
        )
        .is_ok());
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

    #[test]
    fn polling_policy_clamps_intervals_and_uses_bounded_backoff() {
        let mut config = ImageAdapterConfig {
            poll_interval_secs: 0,
            timeout_secs: 1,
            ..Default::default()
        };
        assert_eq!(config.normalized_poll_interval(), 1);
        assert_eq!(config.normalized_timeout(), 60);
        assert_eq!(poll_delay(&config, 0), 1);
        assert_eq!(poll_delay(&config, 4), 16);

        config.poll_interval_secs = 30;
        config.timeout_secs = 100_000;
        assert_eq!(poll_delay(&config, 4), 30);
        assert_eq!(config.normalized_timeout(), 86_400);
    }

    #[test]
    fn drawing_errors_redact_custom_header_values() {
        let provider = ProviderConfig {
            id: "custom".into(),
            name: "Custom".into(),
            provider_type: ProviderType::Custom,
            api_host: "https://example.com".into(),
            api_path: None,
            enabled: true,
            models: Vec::new(),
            keys: Vec::new(),
            proxy_config: None,
            custom_headers: Some(r#"{"x-secret":"header-secret"}"#.into()),
            icon: None,
            builtin_id: None,
            sort_order: 0,
            created_at: 0,
            updated_at: 0,
        };

        let sanitized = sanitize_error("request failed with x-secret=header-secret", &provider);
        assert!(!sanitized.contains("header-secret"));
        assert!(sanitized.contains("[REDACTED]"));
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
                adapter_id: None,
                adapter_config_snapshot: None,
                deadline_at: None,
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
                adapter_id: None,
                adapter_config_snapshot: None,
                deadline_at: None,
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
                adapter_id: None,
                adapter_config_snapshot: None,
                deadline_at: None,
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

        assert!(
            aqbot_core::repo::drawing::get_generation(&db.conn, &generation.id)
                .await
                .is_err()
        );
        assert!(
            aqbot_core::repo::stored_file::get_stored_file(&db.conn, &stored.id)
                .await
                .is_ok()
        );
        assert!(file_store.read_file(&stored.storage_path).is_ok());
    }
}
