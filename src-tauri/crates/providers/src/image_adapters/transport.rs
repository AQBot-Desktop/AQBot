use super::{
    parse_response_payload, resolved_gemini_api_mode, ImageAdapterConfig, ImageAdapterRequest,
    ImageApiMode, ImageAuthMode, ImageSubmission, ParsedImageSource, ParsedResponsePayload,
};
use crate::openai_images::{ImageApiImage, ImageApiOutput};
use crate::{resolve_chat_url, ProviderRequestContext};
use aqbot_core::error::{AQBotError, Result};
use base64::Engine;
use futures::StreamExt;
use reqwest::{RequestBuilder, Response};

const MAX_IMAGE_DOWNLOAD_BYTES: usize = 50 * 1024 * 1024;

pub(super) async fn parse_http_response(
    adapter_id: &str,
    client: &reqwest::Client,
    response: Response,
    config: &ImageAdapterConfig,
) -> Result<ImageSubmission> {
    let status = response.status();
    let bytes = response
        .bytes()
        .await
        .map_err(|error| AQBotError::Provider(format!("Failed to read image response: {error}")))?;
    if !status.is_success() {
        let message = String::from_utf8_lossy(&bytes);
        return Err(AQBotError::Provider(format!(
            "Image API error ({status}): {message}"
        )));
    }
    let value: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|error| AQBotError::Provider(format!("Invalid image API response: {error}")))?;
    match parse_response_payload(adapter_id, &value, config)? {
        ParsedResponsePayload::Pending(pending) => Ok(ImageSubmission::Pending(pending)),
        ParsedResponsePayload::Completed(completed) => {
            let mut images = Vec::with_capacity(completed.images.len());
            for image in completed.images {
                let materialized = materialize_image(client, image.source).await?;
                let declared_mime_type = merge_declared_mime_types(
                    image.declared_mime_type,
                    materialized.declared_mime_type,
                )?;
                images.push(ImageApiImage {
                    bytes: materialized.bytes,
                    declared_mime_type,
                    revised_prompt: image.revised_prompt,
                });
            }
            Ok(ImageSubmission::Completed(ImageApiOutput {
                response_id: completed.response_id,
                usage_json: completed.usage_json,
                images,
            }))
        }
    }
}

struct MaterializedImage {
    bytes: Vec<u8>,
    declared_mime_type: Option<String>,
}

async fn materialize_image(
    client: &reqwest::Client,
    source: ParsedImageSource,
) -> Result<MaterializedImage> {
    match source {
        ParsedImageSource::Base64(data) => base64::engine::general_purpose::STANDARD
            .decode(data)
            .map(|bytes| MaterializedImage {
                bytes,
                declared_mime_type: None,
            })
            .map_err(|error| AQBotError::Provider(format!("Invalid image base64: {error}"))),
        ParsedImageSource::Url(url) => download_image(client, &url).await,
    }
}

async fn download_image(client: &reqwest::Client, url: &str) -> Result<MaterializedImage> {
    let response = client
        .get(url)
        .send()
        .await
        .and_then(Response::error_for_status)
        .map_err(|error| {
            AQBotError::Provider(format!("Failed to download generated image: {error}"))
        })?;
    let declared_mime_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .map(normalize_http_content_type)
        .transpose()?
        .flatten();
    let mut stream = response.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|error| {
            AQBotError::Provider(format!("Failed to read generated image: {error}"))
        })?;
        if bytes.len() + chunk.len() > MAX_IMAGE_DOWNLOAD_BYTES {
            return Err(AQBotError::Provider("Downloaded image is too large".into()));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(MaterializedImage {
        bytes,
        declared_mime_type,
    })
}

fn normalize_http_content_type(value: &str) -> Result<Option<String>> {
    let mime_type = value
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    if mime_type.is_empty() || mime_type == "application/octet-stream" {
        return Ok(None);
    }
    if !mime_type.starts_with("image/") {
        return Err(AQBotError::Provider(format!(
            "Generated image URL returned non-image Content-Type {mime_type}"
        )));
    }
    Ok(Some(if mime_type == "image/jpg" {
        "image/jpeg".into()
    } else {
        mime_type
    }))
}

fn merge_declared_mime_types(
    response_mime_type: Option<String>,
    http_mime_type: Option<String>,
) -> Result<Option<String>> {
    let response_mime_type = response_mime_type.map(|value| {
        let normalized = value.trim().to_ascii_lowercase();
        if normalized == "image/jpg" {
            "image/jpeg".into()
        } else {
            normalized
        }
    });
    if let (Some(response), Some(http)) = (&response_mime_type, &http_mime_type) {
        if response != http {
            return Err(AQBotError::Provider(format!(
                "Image response MIME type {response} does not match downloaded Content-Type {http}"
            )));
        }
    }
    Ok(response_mime_type.or(http_mime_type))
}

pub(super) fn authorize(
    builder: RequestBuilder,
    adapter_id: &str,
    ctx: &ProviderRequestContext,
    config: &ImageAdapterConfig,
) -> RequestBuilder {
    if adapter_id == "gemini_images" && config.auth_mode == ImageAuthMode::Bearer {
        return builder.header("x-goog-api-key", &ctx.api_key);
    }
    match config.auth_mode {
        ImageAuthMode::Bearer => builder.bearer_auth(&ctx.api_key),
        ImageAuthMode::ApiKeyHeader => builder.header(
            config.auth_header.as_deref().unwrap_or("x-api-key"),
            &ctx.api_key,
        ),
        ImageAuthMode::Query => builder.query(&[("key", &ctx.api_key)]),
        ImageAuthMode::None => builder,
    }
}

pub(super) fn submit_url(
    adapter_id: &str,
    ctx: &ProviderRequestContext,
    request: &ImageAdapterRequest,
    config: &ImageAdapterConfig,
) -> Result<String> {
    let configured_endpoint = match request.operation {
        super::ImageOperation::Generate => config.endpoint.as_deref(),
        super::ImageOperation::Edit | super::ImageOperation::MaskEdit => {
            config.edit_endpoint.as_deref().or_else(|| {
                (adapter_id == "generic_json")
                    .then_some(config.endpoint.as_deref())
                    .flatten()
            })
        }
    };
    if let Some(endpoint) = configured_endpoint {
        return Ok(endpoint_url(
            ctx,
            &endpoint.replace("{model}", &request.model),
        ));
    }
    let suffix = match adapter_id {
        "gemini_images" => match resolved_gemini_api_mode(&request.model, config) {
            ImageApiMode::Interactions => "/interactions".to_string(),
            ImageApiMode::Predict => format!("/models/{}:predict", request.model),
            ImageApiMode::Auto | ImageApiMode::GenerateContent => {
                format!("/models/{}:generateContent", request.model)
            }
        },
        "xai_images" if request.operation != super::ImageOperation::Generate => {
            "/images/edits".to_string()
        }
        "xai_images" | "glm_images" | "siliconflow_images" => "/images/generations".to_string(),
        // generic_json defaults to OpenAI-compatible image paths so proxy setups
        // work without forcing a manual endpoint; users can still override.
        "generic_json" if request.operation != super::ImageOperation::Generate => {
            "/images/edits".to_string()
        }
        "generic_json" => "/images/generations".to_string(),
        _ => "/images/generations".to_string(),
    };
    Ok(endpoint_url(ctx, &suffix))
}

pub(super) fn endpoint_url(ctx: &ProviderRequestContext, endpoint: &str) -> String {
    if endpoint.starts_with("http://") || endpoint.starts_with("https://") {
        return endpoint.to_string();
    }
    resolve_chat_url(
        ctx.base_url.as_deref().unwrap_or_default(),
        Some(endpoint),
        "",
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::image_adapters::ImageOperation;

    fn context() -> ProviderRequestContext {
        ProviderRequestContext {
            api_key: "secret-token".into(),
            key_id: "key-1".into(),
            provider_id: "provider-1".into(),
            base_url: Some("https://example.com/v1".into()),
            api_path: None,
            aws_region: None,
            proxy_config: None,
            custom_headers: None,
        }
    }

    fn request(operation: ImageOperation) -> ImageAdapterRequest {
        ImageAdapterRequest {
            operation,
            model: "grok-imagine-image".into(),
            prompt: "draw".into(),
            n: 1,
            size: "1024x1024".into(),
            quality: "auto".into(),
            output_format: "png".into(),
            background: None,
            output_compression: None,
            images: Vec::new(),
            mask: None,
            parameters: serde_json::Map::new(),
        }
    }

    #[test]
    fn applies_profile_authentication_without_exposing_it_in_the_url() {
        let client = reqwest::Client::new();
        let bearer = authorize(
            client.get("https://example.com"),
            "xai_images",
            &context(),
            &ImageAdapterConfig::default(),
        )
        .build()
        .unwrap();
        assert_eq!(
            bearer.headers().get("authorization").unwrap(),
            "Bearer secret-token"
        );
        assert!(!bearer.url().as_str().contains("secret-token"));

        let gemini = authorize(
            client.get("https://example.com"),
            "gemini_images",
            &context(),
            &ImageAdapterConfig::default(),
        )
        .build()
        .unwrap();
        assert_eq!(
            gemini.headers().get("x-goog-api-key").unwrap(),
            "secret-token"
        );
        assert!(gemini.headers().get("authorization").is_none());
    }

    #[test]
    fn supports_structured_custom_header_and_query_authentication() {
        let client = reqwest::Client::new();
        let mut config = ImageAdapterConfig {
            auth_mode: ImageAuthMode::ApiKeyHeader,
            auth_header: Some("x-custom-key".into()),
            ..Default::default()
        };
        let header = authorize(
            client.get("https://example.com"),
            "generic_json",
            &context(),
            &config,
        )
        .build()
        .unwrap();
        assert_eq!(
            header.headers().get("x-custom-key").unwrap(),
            "secret-token"
        );

        config.auth_mode = ImageAuthMode::Query;
        let query = authorize(
            client.get("https://example.com"),
            "generic_json",
            &context(),
            &config,
        )
        .build()
        .unwrap();
        assert_eq!(query.url().query(), Some("key=secret-token"));
    }

    #[test]
    fn normalizes_and_reconciles_downloaded_image_content_types() {
        assert_eq!(
            normalize_http_content_type("image/jpg; charset=binary").unwrap(),
            Some("image/jpeg".into())
        );
        assert_eq!(
            normalize_http_content_type("application/octet-stream").unwrap(),
            None
        );
        assert!(normalize_http_content_type("text/html").is_err());
        assert_eq!(
            merge_declared_mime_types(Some("image/jpg".into()), Some("image/jpeg".into())).unwrap(),
            Some("image/jpeg".into())
        );
        assert!(
            merge_declared_mime_types(Some("image/png".into()), Some("image/webp".into())).is_err()
        );
    }

    #[test]
    fn resolves_builtin_and_custom_profile_endpoints() {
        let ctx = context();
        let config = ImageAdapterConfig::default();
        assert_eq!(
            submit_url(
                "xai_images",
                &ctx,
                &request(ImageOperation::Generate),
                &config,
            )
            .unwrap(),
            "https://example.com/v1/images/generations"
        );
        assert_eq!(
            submit_url("xai_images", &ctx, &request(ImageOperation::Edit), &config,).unwrap(),
            "https://example.com/v1/images/edits"
        );

        let mut gemini = request(ImageOperation::Generate);
        gemini.model = "gemini-3.1-flash-image".into();
        assert_eq!(
            submit_url("gemini_images", &ctx, &gemini, &config).unwrap(),
            "https://example.com/v1/interactions"
        );
        gemini.model = "gemini-2.5-flash-image".into();
        assert_eq!(
            submit_url("gemini_images", &ctx, &gemini, &config).unwrap(),
            "https://example.com/v1/models/gemini-2.5-flash-image:generateContent"
        );
        gemini.model = "imagen-4.0-generate-001".into();
        assert_eq!(
            submit_url("gemini_images", &ctx, &gemini, &config).unwrap(),
            "https://example.com/v1/models/imagen-4.0-generate-001:predict"
        );

        let generic = ImageAdapterConfig {
            endpoint: Some("/custom/images".into()),
            ..Default::default()
        };
        assert_eq!(
            submit_url(
                "generic_json",
                &ctx,
                &request(ImageOperation::Generate),
                &generic,
            )
            .unwrap(),
            "https://example.com/v1/custom/images"
        );

        // Without an explicit endpoint, generic_json falls back to OpenAI-compatible paths.
        assert_eq!(
            submit_url(
                "generic_json",
                &ctx,
                &request(ImageOperation::Generate),
                &config,
            )
            .unwrap(),
            "https://example.com/v1/images/generations"
        );
        assert_eq!(
            submit_url(
                "generic_json",
                &ctx,
                &request(ImageOperation::Edit),
                &config
            )
            .unwrap(),
            "https://example.com/v1/images/edits"
        );
    }
}
