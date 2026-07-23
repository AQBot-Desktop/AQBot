use super::transport::{authorize, endpoint_url, parse_http_response, submit_url};
use super::{
    build_request_body, ImageAdapterConfig, ImageAdapterRequest, ImagePollResult, ImageSubmission,
    PendingImageSubmission,
};
use crate::openai_images::{
    ImageEditImageFormat, ImageEditRequest, ImageEditTransferMode, ImageGenerateRequest,
    OpenAIImagesClient,
};
use crate::{apply_request_headers, build_default_http_client, ProviderRequestContext};
use aqbot_core::error::{AQBotError, Result};

pub async fn submit_profile(
    adapter_id: &str,
    ctx: &ProviderRequestContext,
    request: ImageAdapterRequest,
    config: &ImageAdapterConfig,
) -> Result<ImageSubmission> {
    if adapter_id == "openai_images" {
        return redact_result(submit_openai(ctx, request, config).await, &ctx.api_key);
    }
    let client = build_default_http_client()?;
    let url = submit_url(adapter_id, ctx, &request, config)?;
    let body = build_request_body(adapter_id, &request, config)?;
    let builder = authorize(client.post(url).json(&body), adapter_id, ctx, config);
    let response = apply_request_headers(builder, ctx)
        .send()
        .await
        .map_err(|error| {
            AQBotError::Provider(redact_message(
                format!("Image submission failed: {error}"),
                &ctx.api_key,
            ))
        })?;
    redact_result(
        parse_http_response(adapter_id, &client, response, config).await,
        &ctx.api_key,
    )
}

pub async fn poll_profile(
    adapter_id: &str,
    ctx: &ProviderRequestContext,
    task: &PendingImageSubmission,
    config: &ImageAdapterConfig,
) -> Result<ImagePollResult> {
    let endpoint = config.poll_endpoint.as_deref().ok_or_else(|| {
        AQBotError::Provider(format!("{adapter_id} does not define a polling endpoint"))
    })?;
    let client = build_default_http_client()?;
    let url = endpoint_url(ctx, &endpoint.replace("{task_id}", &task.remote_task_id));
    let builder = authorize(client.get(url), adapter_id, ctx, config);
    let response = apply_request_headers(builder, ctx)
        .send()
        .await
        .map_err(|error| {
            AQBotError::Provider(redact_message(
                format!("Image polling failed: {error}"),
                &ctx.api_key,
            ))
        })?;
    let parsed = redact_result(
        parse_http_response(adapter_id, &client, response, config).await,
        &ctx.api_key,
    )?;
    match parsed {
        ImageSubmission::Completed(output) => Ok(ImagePollResult::Completed(output)),
        ImageSubmission::Pending(pending) => Ok(ImagePollResult::Pending(pending)),
    }
}

fn redact_result<T>(result: Result<T>, secret: &str) -> Result<T> {
    result.map_err(|error| {
        let message = redact_message(error.to_string(), secret);
        AQBotError::Provider(message)
    })
}

fn redact_message(message: String, secret: &str) -> String {
    if secret.is_empty() {
        message
    } else {
        message.replace(secret, "[REDACTED]")
    }
}

pub async fn cancel_profile(
    adapter_id: &str,
    ctx: &ProviderRequestContext,
    task: &PendingImageSubmission,
    config: &ImageAdapterConfig,
) -> Result<()> {
    let Some(endpoint) = config.cancel_endpoint.as_deref() else {
        return Ok(());
    };
    let client = build_default_http_client()?;
    let url = endpoint_url(ctx, &endpoint.replace("{task_id}", &task.remote_task_id));
    let builder = authorize(client.post(url), adapter_id, ctx, config);
    let result = apply_request_headers(builder, ctx)
        .send()
        .await
        .map_err(|error| AQBotError::Provider(format!("Image cancellation failed: {error}")))
        .and_then(|response| {
            response.error_for_status().map_err(|error| {
                AQBotError::Provider(format!("Image cancellation failed: {error}"))
            })
        })
        .map(|_| ());
    redact_result(result, &ctx.api_key)
}

async fn submit_openai(
    ctx: &ProviderRequestContext,
    request: ImageAdapterRequest,
    config: &ImageAdapterConfig,
) -> Result<ImageSubmission> {
    let client = OpenAIImagesClient::new();
    let output = match request.operation {
        super::ImageOperation::Generate => {
            client
                .generate(
                    ctx,
                    ImageGenerateRequest {
                        model: request.model,
                        prompt: request.prompt,
                        n: request.n,
                        size: request.size,
                        quality: request.quality,
                        output_format: request.output_format,
                        background: request.background,
                        output_compression: request.output_compression,
                    },
                    config.endpoint.as_deref(),
                )
                .await?
        }
        super::ImageOperation::Edit | super::ImageOperation::MaskEdit => {
            let transfer_mode = match request
                .parameters
                .get("_aqbot_reference_mode")
                .and_then(serde_json::Value::as_str)
            {
                Some("multipart") => ImageEditTransferMode::Multipart,
                _ => ImageEditTransferMode::Base64,
            };
            let image_format = match request
                .parameters
                .get("_aqbot_reference_format")
                .and_then(serde_json::Value::as_str)
            {
                Some("string") => ImageEditImageFormat::String,
                _ => ImageEditImageFormat::Object,
            };
            let image_param_name = request
                .parameters
                .get("_aqbot_reference_param")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("images")
                .to_string();
            client
                .edit(
                    ctx,
                    ImageEditRequest {
                        model: request.model,
                        prompt: request.prompt,
                        n: request.n,
                        size: request.size,
                        quality: request.quality,
                        output_format: request.output_format,
                        background: request.background,
                        output_compression: request.output_compression,
                        transfer_mode,
                        image_format,
                        image_param_name,
                        images: request.images,
                        mask: request.mask,
                    },
                    config.edit_endpoint.as_deref(),
                )
                .await?
        }
    };
    Ok(ImageSubmission::Completed(output))
}

#[cfg(test)]
mod tests {
    use super::redact_message;

    #[test]
    fn redacts_api_keys_from_adapter_errors() {
        let message = redact_message(
            "request to ?key=super-secret failed: super-secret".into(),
            "super-secret",
        );
        assert!(!message.contains("super-secret"));
        assert!(message.contains("[REDACTED]"));
    }
}
