use crate::AppState;
use aqbot_core::file_store::FileStore;
use aqbot_core::repo::drawing::{
    DrawingGeneration, DrawingImage, NewDrawingGeneration, NewDrawingImage,
};
use aqbot_core::types::{ProviderConfig, ProviderProxyConfig, ProviderType};
use aqbot_providers::openai_images::{
    ImageEditRequest, ImageGenerateRequest, ImageUpload, OpenAIImagesClient,
};
use aqbot_providers::{resolve_base_url_for_type, ProviderRequestContext};
use base64::Engine;
use image::GenericImageView;
use serde::{Deserialize, Serialize};
use tauri::State;

const MAX_IMAGE_BYTES: usize = 50 * 1024 * 1024;
const MAX_REFERENCE_IMAGES: usize = 16;
const MAX_BATCH_IMAGES: u8 = 10;
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
    pub reference_file_ids: Vec<String>,
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
    pub reference_file_ids: Vec<String>,
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
    pub reference_file_ids: Vec<String>,
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
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(&input.data)
        .map_err(|e| format!("Invalid base64: {}", e))?;
    validate_upload_image(&bytes, &input.mime_type)?;

    aqbot_core::storage_paths::ensure_documents_dirs()
        .map_err(|e| format!("Failed to ensure documents dirs: {}", e))?;
    let file_store = FileStore::new();
    let saved = file_store
        .save_file(&bytes, &input.file_name, &input.mime_type)
        .map_err(|e| e.to_string())?;
    let id = aqbot_core::utils::gen_id();
    let stored = aqbot_core::repo::stored_file::create_stored_file(
        &state.sea_db,
        &id,
        &saved.hash,
        &input.file_name,
        &input.mime_type,
        saved.size_bytes,
        &saved.storage_path,
        None,
    )
    .await
    .map_err(|e| e.to_string())?;

    Ok(DrawingStoredFile {
        id: stored.id,
        original_name: stored.original_name,
        mime_type: stored.mime_type,
        size_bytes: stored.size_bytes,
        storage_path: stored.storage_path,
    })
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
            )
            .await
    } else {
        let uploads = load_reference_uploads(&state, &input.reference_file_ids).await?;
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
                    images: uploads,
                    mask: None,
                },
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
                images: uploads,
                mask: None,
            },
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
                images: uploads,
                mask,
            },
        )
        .await;

    persist_api_result(&state, generation, result, &input.output_format, &provider).await
}

#[tauri::command]
pub async fn delete_drawing_generation(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    aqbot_core::repo::drawing::delete_generation(&state.sea_db, &id)
        .await
        .map_err(|e| e.to_string())
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
    aqbot_core::repo::drawing::create_generation(
        &state.sea_db,
        NewDrawingGeneration {
            parent_generation_id,
            provider_id: provider_id.to_string(),
            key_id: key_id.to_string(),
            model_id: model_id.to_string(),
            action: action.to_string(),
            prompt: prompt.trim().to_string(),
            parameters_json: serde_json::to_string(parameters).map_err(|e| e.to_string())?,
            reference_file_ids_json: serde_json::to_string(reference_file_ids)
                .map_err(|e| e.to_string())?,
            source_image_ids_json: serde_json::to_string(source_image_ids)
                .map_err(|e| e.to_string())?,
            mask_file_id,
        },
    )
    .await
    .map_err(|e| e.to_string())
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
            let mime_type = output_format_to_mime(output_format);
            for (index, image) in output.images.into_iter().enumerate() {
                let ext = output_format_to_extension(output_format);
                let file_name = format!("drawing-{}-{}.{}", generation.id, index + 1, ext);
                let saved = FileStore::new()
                    .save_file(&image.bytes, &file_name, mime_type)
                    .map_err(|e| e.to_string())?;
                let stored_file_id = aqbot_core::utils::gen_id();
                aqbot_core::repo::stored_file::create_stored_file(
                    &state.sea_db,
                    &stored_file_id,
                    &saved.hash,
                    &file_name,
                    mime_type,
                    saved.size_bytes,
                    &saved.storage_path,
                    None,
                )
                .await
                .map_err(|e| e.to_string())?;
                let dimensions = image_dimensions(&image.bytes).ok();
                aqbot_core::repo::drawing::add_image(
                    &state.sea_db,
                    NewDrawingImage {
                        generation_id: generation.id.clone(),
                        stored_file_id,
                        storage_path: saved.storage_path,
                        mime_type: mime_type.to_string(),
                        width: dimensions.map(|d| d.0 as i32),
                        height: dimensions.map(|d| d.1 as i32),
                        revised_prompt: image.revised_prompt,
                    },
                )
                .await
                .map_err(|e| e.to_string())?;
            }
            aqbot_core::repo::drawing::mark_generation_succeeded(
                &state.sea_db,
                &generation.id,
                output.response_id,
                output.usage_json,
            )
            .await
            .map_err(|e| e.to_string())?;
            aqbot_core::repo::drawing::get_generation(&state.sea_db, &generation.id)
                .await
                .map_err(|e| e.to_string())
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
}
