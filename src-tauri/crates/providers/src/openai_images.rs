use aqbot_core::error::{AQBotError, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::{
    apply_request_headers, build_default_http_client, build_http_client, resolve_chat_url,
    ProviderRequestContext,
};

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";

#[derive(Debug, Clone, Serialize)]
pub struct ImageGenerateRequest {
    pub model: String,
    pub prompt: String,
    pub n: u8,
    pub size: String,
    pub quality: String,
    pub output_format: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub background: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub output_compression: Option<u8>,
}

#[derive(Debug, Clone)]
pub struct ImageEditRequest {
    pub model: String,
    pub prompt: String,
    pub n: u8,
    pub size: String,
    pub quality: String,
    pub output_format: String,
    pub background: Option<String>,
    pub output_compression: Option<u8>,
    pub images: Vec<ImageUpload>,
    pub mask: Option<ImageUpload>,
}

#[derive(Debug, Clone)]
pub struct ImageUpload {
    pub bytes: Vec<u8>,
    pub file_name: String,
    pub mime_type: String,
}

#[derive(Debug, Clone)]
pub struct ImageApiOutput {
    pub response_id: Option<String>,
    pub usage_json: Option<String>,
    pub images: Vec<ImageApiImage>,
}

#[derive(Debug, Clone)]
pub struct ImageApiImage {
    pub bytes: Vec<u8>,
    pub revised_prompt: Option<String>,
}

#[derive(Deserialize)]
struct ImageApiResponse {
    id: Option<String>,
    usage: Option<serde_json::Value>,
    #[serde(default)]
    data: Vec<ImageData>,
}

#[derive(Deserialize)]
struct ImageData {
    b64_json: Option<String>,
    revised_prompt: Option<String>,
}

pub struct OpenAIImagesClient {
    client: reqwest::Client,
}

impl OpenAIImagesClient {
    pub fn new() -> Self {
        Self {
            client: build_default_http_client().expect("Failed to build default HTTP client"),
        }
    }

    fn base_url(ctx: &ProviderRequestContext) -> String {
        ctx.base_url
            .clone()
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
    }

    fn generate_url(ctx: &ProviderRequestContext) -> String {
        resolve_chat_url(
            &Self::base_url(ctx),
            ctx.api_path.as_deref(),
            "/images/generations",
        )
    }

    fn edit_url(ctx: &ProviderRequestContext) -> String {
        resolve_chat_url(
            &Self::base_url(ctx),
            ctx.api_path.as_deref(),
            "/images/edits",
        )
    }

    fn get_client(&self, ctx: &ProviderRequestContext) -> Result<reqwest::Client> {
        match &ctx.proxy_config {
            Some(c) if c.proxy_type.as_deref() != Some("none") => build_http_client(Some(c)),
            _ => Ok(self.client.clone()),
        }
    }

    pub async fn generate(
        &self,
        ctx: &ProviderRequestContext,
        request: ImageGenerateRequest,
    ) -> Result<ImageApiOutput> {
        let client = self.get_client(ctx)?;
        let builder = client
            .post(Self::generate_url(ctx))
            .bearer_auth(&ctx.api_key)
            .json(&request);
        let response = apply_request_headers(builder, ctx)
            .send()
            .await
            .map_err(|e| AQBotError::Provider(format!("Image generation failed: {}", e)))?;
        parse_response(response).await
    }

    pub async fn edit(
        &self,
        ctx: &ProviderRequestContext,
        request: ImageEditRequest,
    ) -> Result<ImageApiOutput> {
        let client = self.get_client(ctx)?;
        let mut form = reqwest::multipart::Form::new()
            .text("model", request.model)
            .text("prompt", request.prompt)
            .text("n", request.n.to_string())
            .text("size", request.size)
            .text("quality", request.quality)
            .text("output_format", request.output_format);

        if let Some(background) = request.background {
            form = form.text("background", background);
        }
        if let Some(compression) = request.output_compression {
            form = form.text("output_compression", compression.to_string());
        }
        for image in request.images {
            let part = reqwest::multipart::Part::bytes(image.bytes)
                .file_name(image.file_name)
                .mime_str(&image.mime_type)
                .map_err(|e| AQBotError::Provider(format!("Invalid image MIME type: {}", e)))?;
            form = form.part("image[]", part);
        }
        if let Some(mask) = request.mask {
            let part = reqwest::multipart::Part::bytes(mask.bytes)
                .file_name(mask.file_name)
                .mime_str(&mask.mime_type)
                .map_err(|e| AQBotError::Provider(format!("Invalid mask MIME type: {}", e)))?;
            form = form.part("mask", part);
        }

        let builder = client
            .post(Self::edit_url(ctx))
            .bearer_auth(&ctx.api_key)
            .multipart(form);
        let response = apply_request_headers(builder, ctx)
            .send()
            .await
            .map_err(|e| AQBotError::Provider(format!("Image edit failed: {}", e)))?;
        parse_response(response).await
    }
}

async fn parse_response(response: reqwest::Response) -> Result<ImageApiOutput> {
    let status = response.status();
    if !status.is_success() {
        let text = response.text().await.unwrap_or_default();
        return Err(AQBotError::Provider(format!(
            "OpenAI image API error {}: {}",
            status, text
        )));
    }
    let body: ImageApiResponse = response
        .json()
        .await
        .map_err(|e| AQBotError::Provider(format!("Invalid image API response: {}", e)))?;

    let mut images = Vec::with_capacity(body.data.len());
    for item in body.data {
        let encoded = item
            .b64_json
            .ok_or_else(|| AQBotError::Provider("Image API response missing b64_json".into()))?;
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(encoded)
            .map_err(|e| AQBotError::Provider(format!("Invalid image b64_json: {}", e)))?;
        images.push(ImageApiImage {
            bytes,
            revised_prompt: item.revised_prompt,
        });
    }

    Ok(ImageApiOutput {
        response_id: body.id,
        usage_json: body.usage.map(|u| u.to_string()),
        images,
    })
}
