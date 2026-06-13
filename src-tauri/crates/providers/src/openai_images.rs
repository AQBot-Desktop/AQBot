use aqbot_core::error::{AQBotError, Result};
use base64::Engine;
use futures::StreamExt;
use serde::{Deserialize, Serialize};

use crate::{
    apply_request_headers, build_default_http_client, build_http_client, ProviderRequestContext,
};

const DEFAULT_BASE_URL: &str = "https://api.openai.com/v1";
const MAX_IMAGE_DOWNLOAD_BYTES: usize = 50 * 1024 * 1024;

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
    pub transfer_mode: ImageEditTransferMode,
    pub image_format: ImageEditImageFormat,
    pub image_param_name: String,
    pub images: Vec<ImageUpload>,
    pub mask: Option<ImageUpload>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageEditTransferMode {
    Multipart,
    Base64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ImageEditImageFormat {
    Object,
    String,
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
    url: Option<String>,
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

    fn image_url(ctx: &ProviderRequestContext, suffix: &str) -> String {
        format!("{}{}", Self::base_url(ctx).trim_end_matches('/'), suffix)
    }

    fn generate_url(ctx: &ProviderRequestContext, path: Option<&str>) -> String {
        let default_path = "/images/generations";
        Self::image_url(ctx, path.unwrap_or(default_path))
    }

    fn edit_url(ctx: &ProviderRequestContext, path: Option<&str>) -> String {
        let default_path = "/images/edits";
        Self::image_url(ctx, path.unwrap_or(default_path))
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
        path: Option<&str>,
    ) -> Result<ImageApiOutput> {
        let client = self.get_client(ctx)?;
        let builder = client
            .post(Self::generate_url(ctx, path))
            .bearer_auth(&ctx.api_key)
            .json(&request);
        let response = apply_request_headers(builder, ctx)
            .send()
            .await
            .map_err(|e| AQBotError::Provider(format!("Image generation failed: {}", e)))?;
        parse_response(&client, response).await
    }

    pub async fn edit(
        &self,
        ctx: &ProviderRequestContext,
        request: ImageEditRequest,
        path: Option<&str>,
    ) -> Result<ImageApiOutput> {
        let client = self.get_client(ctx)?;
        let builder = client
            .post(Self::edit_url(ctx, path))
            .bearer_auth(&ctx.api_key);
        let builder = match request.transfer_mode {
            ImageEditTransferMode::Multipart => {
                builder.multipart(build_edit_multipart_form(request)?)
            }
            ImageEditTransferMode::Base64 => {
                let body = build_edit_json_request(request)?;
                builder
                    .body(body)
                    .header("Content-Type", "application/json")
            }
        };
        let response = apply_request_headers(builder, ctx)
            .send()
            .await
            .map_err(|e| AQBotError::Provider(format!("Image edit failed: {}", e)))?;
        parse_response(&client, response).await
    }
}

fn image_upload_to_part(upload: ImageUpload) -> Result<reqwest::multipart::Part> {
    reqwest::multipart::Part::bytes(upload.bytes)
        .file_name(upload.file_name)
        .mime_str(&upload.mime_type)
        .map_err(|e| AQBotError::Provider(format!("Invalid image MIME type: {}", e)))
}

fn build_edit_multipart_form(request: ImageEditRequest) -> Result<reqwest::multipart::Form> {
    let image_param_name = multipart_image_param_name(&request.image_param_name).to_string();
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
    if let Some(output_compression) = request.output_compression {
        form = form.text("output_compression", output_compression.to_string());
    }

    for upload in request.images {
        form = form.part(image_param_name.clone(), image_upload_to_part(upload)?);
    }
    if let Some(mask) = request.mask {
        form = form.part("mask", image_upload_to_part(mask)?);
    }

    Ok(form)
}

fn image_upload_to_string(upload: ImageUpload) -> String {
    let data = base64::engine::general_purpose::STANDARD.encode(upload.bytes);
    format!("data:{};base64,{}", upload.mime_type, data)
}

fn image_upload_to_image_url_object(upload: ImageUpload) -> serde_json::Value {
    let mut obj = serde_json::Map::new();
    obj.insert(
        "image_url".to_string(),
        serde_json::Value::String(image_upload_to_string(upload)),
    );
    serde_json::Value::Object(obj)
}

fn multipart_image_param_name(value: &str) -> &str {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        "image[]"
    } else {
        trimmed
    }
}

fn json_image_param_name(value: &str) -> &str {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        "images"
    } else {
        trimmed
    }
}

fn build_edit_json_request(request: ImageEditRequest) -> Result<Vec<u8>> {
    let mut map = serde_json::Map::new();
    let image_param_name = json_image_param_name(&request.image_param_name).to_string();
    map.insert(
        "model".to_string(),
        serde_json::Value::String(request.model),
    );
    map.insert(
        "prompt".to_string(),
        serde_json::Value::String(request.prompt),
    );
    map.insert("n".to_string(), serde_json::Value::Number(request.n.into()));
    map.insert("size".to_string(), serde_json::Value::String(request.size));
    map.insert(
        "quality".to_string(),
        serde_json::Value::String(request.quality),
    );
    map.insert(
        "output_format".to_string(),
        serde_json::Value::String(request.output_format),
    );

    if let Some(background) = request.background {
        map.insert(
            "background".to_string(),
            serde_json::Value::String(background),
        );
    }
    if let Some(output_compression) = request.output_compression {
        map.insert(
            "output_compression".to_string(),
            serde_json::Value::Number(output_compression.into()),
        );
    }

    if request.images.is_empty() {
        return Err(AQBotError::Provider(
            "No image provided for edit request".into(),
        ));
    }

    match request.image_format {
        ImageEditImageFormat::Object => {
            let images: Vec<serde_json::Value> = request
                .images
                .into_iter()
                .map(image_upload_to_image_url_object)
                .collect();
            map.insert(image_param_name, serde_json::Value::Array(images));
        }
        ImageEditImageFormat::String => {
            let images: Vec<serde_json::Value> = request
                .images
                .into_iter()
                .map(|upload| serde_json::Value::String(image_upload_to_string(upload)))
                .collect();
            map.insert(image_param_name, serde_json::Value::Array(images));
        }
    }

    if let Some(mask) = request.mask {
        let mask_value = match request.image_format {
            ImageEditImageFormat::Object => image_upload_to_image_url_object(mask),
            ImageEditImageFormat::String => {
                serde_json::Value::String(image_upload_to_string(mask))
            }
        };
        map.insert("mask".to_string(), mask_value);
    }

    let value = serde_json::Value::Object(map);
    serde_json::to_vec(&value)
        .map_err(|e| AQBotError::Provider(format!("Failed to serialize edit request: {}", e)))
}

async fn fetch_image_url(client: &reqwest::Client, url: &str) -> Result<Vec<u8>> {
    let response = client
        .get(url)
        .send()
        .await
        .map_err(|e| AQBotError::Provider(format!("Failed to fetch image from URL: {}", e)))?;
    let status = response.status();
    if !status.is_success() {
        return Err(AQBotError::Provider(format!(
            "Image URL returned HTTP {}",
            status
        )));
    }
    if let Some(content_length) = response.content_length() {
        if content_length > MAX_IMAGE_DOWNLOAD_BYTES as u64 {
            return Err(AQBotError::Provider(format!(
                "Image URL response exceeds {} bytes",
                MAX_IMAGE_DOWNLOAD_BYTES
            )));
        }
    }

    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk
            .map_err(|e| AQBotError::Provider(format!("Failed to read image bytes: {}", e)))?;
        let next_len = bytes.len().saturating_add(chunk.len());
        if next_len > MAX_IMAGE_DOWNLOAD_BYTES {
            return Err(AQBotError::Provider(format!(
                "Image URL response exceeds {} bytes",
                MAX_IMAGE_DOWNLOAD_BYTES
            )));
        }
        bytes.extend_from_slice(&chunk);
    }

    if bytes.is_empty() {
        return Err(AQBotError::Provider("Image URL response is empty".into()));
    }
    image::load_from_memory(&bytes).map_err(|e| {
        AQBotError::Provider(format!("Image URL response is not a valid image: {}", e))
    })?;
    Ok(bytes)
}

async fn parse_response(
    client: &reqwest::Client,
    response: reqwest::Response,
) -> Result<ImageApiOutput> {
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
        let bytes = if let Some(encoded) = item.b64_json {
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|e| AQBotError::Provider(format!("Invalid image b64_json: {}", e)))?
        } else if let Some(url) = item.url {
            fetch_image_url(client, &url).await?
        } else {
            return Err(AQBotError::Provider(
                "Image API response missing both b64_json and url".into(),
            ));
        };
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

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn spawn_http_response(
        response: String,
    ) -> (std::net::SocketAddr, tokio::task::JoinHandle<String>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let addr = listener.local_addr().expect("server addr");
        let server = tokio::spawn(async move {
            let (mut socket, _) = listener.accept().await.expect("accept request");
            let mut request = Vec::new();
            let mut buffer = [0u8; 4096];
            let mut header_end = None;
            let mut content_length = 0usize;

            loop {
                let read = socket.read(&mut buffer).await.expect("read request");
                if read == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..read]);

                if header_end.is_none() {
                    header_end = request.windows(4).position(|window| window == b"\r\n\r\n");
                    if let Some(end) = header_end {
                        let headers = String::from_utf8_lossy(&request[..end]);
                        content_length = headers
                            .lines()
                            .find_map(|line| {
                                line.to_ascii_lowercase()
                                    .strip_prefix("content-length:")
                                    .and_then(|value| value.trim().parse::<usize>().ok())
                            })
                            .unwrap_or(0);
                    }
                }

                if let Some(end) = header_end {
                    if request.len() >= end + 4 + content_length {
                        break;
                    }
                }
            }

            socket
                .write_all(response.as_bytes())
                .await
                .expect("write response");

            String::from_utf8_lossy(&request).into_owned()
        });
        (addr, server)
    }

    fn http_response(status: &str, content_type: &str, body: &str) -> String {
        format!(
            "HTTP/1.1 {}\r\ncontent-type: {}\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
            status,
            content_type,
            body.len(),
            body
        )
    }

    fn context_with_chat_path() -> ProviderRequestContext {
        ProviderRequestContext {
            api_key: "sk-test".to_string(),
            key_id: "key".to_string(),
            provider_id: "provider".to_string(),
            base_url: Some("https://api.openai.com/v1".to_string()),
            api_path: Some("/v1/chat/completions".to_string()),
            proxy_config: None,
            custom_headers: None,
        }
    }

    #[test]
    fn image_urls_ignore_chat_api_path() {
        let ctx = context_with_chat_path();

        assert_eq!(
            OpenAIImagesClient::generate_url(&ctx, None),
            "https://api.openai.com/v1/images/generations"
        );
        assert_eq!(
            OpenAIImagesClient::edit_url(&ctx, None),
            "https://api.openai.com/v1/images/edits"
        );
    }

    #[test]
    fn edit_request_body_serializes_images_as_official_image_url_objects() {
        let body = build_edit_json_request(ImageEditRequest {
            model: "gpt-image-2".to_string(),
            prompt: "换成马斯克".to_string(),
            n: 1,
            size: "1024x1024".to_string(),
            quality: "high".to_string(),
            output_format: "png".to_string(),
            background: Some("auto".to_string()),
            output_compression: None,
            transfer_mode: ImageEditTransferMode::Base64,
            image_format: ImageEditImageFormat::Object,
            image_param_name: "images".to_string(),
            images: vec![ImageUpload {
                bytes: b"abc".to_vec(),
                file_name: "reference.jpg".to_string(),
                mime_type: "image/jpeg".to_string(),
            }],
            mask: None,
        })
        .expect("build edit json request");

        let value: serde_json::Value = serde_json::from_slice(&body).expect("parse json body");
        assert_eq!(value["model"], "gpt-image-2");
        assert_eq!(value["prompt"], "换成马斯克");
        assert_eq!(
            value["images"][0]["image_url"],
            "data:image/jpeg;base64,YWJj"
        );
        assert!(value["images"][0].get("url").is_none());
        assert!(value.get("mask").is_none());
        assert!(value.get("tools").is_none());

        let serialized = value.to_string();
        assert!(!serialized.contains("image[]"));
        assert!(!serialized.contains("reference.jpg"));
        assert!(!serialized.contains("bytes"));
    }

    #[test]
    fn edit_request_body_serializes_images_as_string_array() {
        let body = build_edit_json_request(ImageEditRequest {
            model: "gpt-image-2".to_string(),
            prompt: "换成马斯克".to_string(),
            n: 1,
            size: "1024x1024".to_string(),
            quality: "high".to_string(),
            output_format: "png".to_string(),
            background: Some("auto".to_string()),
            output_compression: None,
            transfer_mode: ImageEditTransferMode::Base64,
            image_format: ImageEditImageFormat::String,
            image_param_name: "images".to_string(),
            images: vec![ImageUpload {
                bytes: b"abc".to_vec(),
                file_name: "reference.jpg".to_string(),
                mime_type: "image/jpeg".to_string(),
            }],
            mask: None,
        })
        .expect("build edit json request");

        let value: serde_json::Value = serde_json::from_slice(&body).expect("parse json body");
        assert_eq!(value["model"], "gpt-image-2");
        assert_eq!(value["prompt"], "换成马斯克");
        assert_eq!(value["images"][0], "data:image/jpeg;base64,YWJj");
        assert!(value.get("mask").is_none());

        let serialized = value.to_string();
        assert!(!serialized.contains("image[]"));
        assert!(!serialized.contains("reference.jpg"));
        assert!(!serialized.contains("bytes"));
    }

    #[test]
    fn edit_request_body_serializes_multiple_images_and_mask_as_image_url_objects() {
        let body = build_edit_json_request(ImageEditRequest {
            model: "gpt-image-2".to_string(),
            prompt: "只替换遮罩区域".to_string(),
            n: 4,
            size: "auto".to_string(),
            quality: "auto".to_string(),
            output_format: "webp".to_string(),
            background: None,
            output_compression: Some(80),
            transfer_mode: ImageEditTransferMode::Base64,
            image_format: ImageEditImageFormat::Object,
            image_param_name: "images".to_string(),
            images: vec![
                ImageUpload {
                    bytes: b"source".to_vec(),
                    file_name: "source.png".to_string(),
                    mime_type: "image/png".to_string(),
                },
                ImageUpload {
                    bytes: b"ref".to_vec(),
                    file_name: "ref.webp".to_string(),
                    mime_type: "image/webp".to_string(),
                },
            ],
            mask: Some(ImageUpload {
                bytes: b"mask".to_vec(),
                file_name: "mask.png".to_string(),
                mime_type: "image/png".to_string(),
            }),
        })
        .expect("build edit json request");

        let value: serde_json::Value = serde_json::from_slice(&body).expect("parse json body");
        assert_eq!(value["n"], 4);
        assert_eq!(value["images"].as_array().expect("images array").len(), 2);
        assert_eq!(
            value["images"][0]["image_url"],
            "data:image/png;base64,c291cmNl"
        );
        assert_eq!(
            value["images"][1]["image_url"],
            "data:image/webp;base64,cmVm"
        );
        assert_eq!(value["mask"]["image_url"], "data:image/png;base64,bWFzaw==");
        assert_eq!(value["output_compression"], 80);
        assert!(value.get("background").is_none());
        assert!(value.get("tools").is_none());

        let serialized = value.to_string();
        assert!(!serialized.contains("image[]"));
        assert!(!serialized.contains("file_name"));
        assert!(!serialized.contains("mime_type"));
    }

    #[test]
    fn edit_request_with_custom_image_param_name() {
        let body = build_edit_json_request(ImageEditRequest {
            model: "gpt-image-2".to_string(),
            prompt: "生成图片".to_string(),
            n: 1,
            size: "1024x1024".to_string(),
            quality: "high".to_string(),
            output_format: "png".to_string(),
            background: None,
            output_compression: None,
            transfer_mode: ImageEditTransferMode::Base64,
            image_format: ImageEditImageFormat::String,
            image_param_name: "image_urls".to_string(),
            images: vec![ImageUpload {
                bytes: b"test".to_vec(),
                file_name: "test.jpg".to_string(),
                mime_type: "image/jpeg".to_string(),
            }],
            mask: None,
        })
        .expect("build edit json request");

        let value: serde_json::Value = serde_json::from_slice(&body).expect("parse json body");
        assert!(value.get("image_urls").is_some());
        assert!(value.get("images").is_none());
        assert_eq!(value["image_urls"][0], "data:image/jpeg;base64,dGVzdA==");
    }

    #[tokio::test]
    async fn edit_sends_multipart_body_with_official_image_array_field_when_requested() {
        let body = r#"{"data":[{"b64_json":"aW1n"}]}"#;
        let (addr, server) =
            spawn_http_response(http_response("200 OK", "application/json", body)).await;

        let ctx = ProviderRequestContext {
            api_key: "sk-test".to_string(),
            key_id: "key".to_string(),
            provider_id: "provider".to_string(),
            base_url: Some(format!("http://{}", addr)),
            api_path: None,
            proxy_config: None,
            custom_headers: None,
        };

        let output = OpenAIImagesClient::new()
            .edit(
                &ctx,
                ImageEditRequest {
                    model: "gpt-image-2".to_string(),
                    prompt: "参考图生成".to_string(),
                    n: 1,
                    size: "auto".to_string(),
                    quality: "auto".to_string(),
                    output_format: "png".to_string(),
                    background: None,
                    output_compression: None,
                    transfer_mode: ImageEditTransferMode::Multipart,
                    image_format: ImageEditImageFormat::String,
                    image_param_name: "".to_string(),
                    images: vec![ImageUpload {
                        bytes: b"abc".to_vec(),
                        file_name: "reference.jpg".to_string(),
                        mime_type: "image/jpeg".to_string(),
                    }],
                    mask: None,
                },
                None,
            )
            .await
            .expect("edit response");

        let request = server.await.expect("server captured request");
        assert_eq!(output.images[0].bytes, b"img");
        assert!(request.starts_with("POST /images/edits HTTP/1.1"));
        assert!(request
            .to_ascii_lowercase()
            .contains("content-type: multipart/form-data; boundary="));
        assert!(request.contains("name=\"image[]\""));
        assert!(!request.contains("name=\"image\""));
        assert!(!request.contains("name=\"reference_images\""));
        assert!(request.contains("filename=\"reference.jpg\""));
        assert!(!request.contains("data:image/jpeg;base64"));
    }

    #[tokio::test]
    async fn image_url_response_rejects_non_success_download() {
        let (image_addr, image_server) =
            spawn_http_response(http_response("404 Not Found", "text/plain", "missing")).await;
        let body = format!(
            r#"{{"data":[{{"url":"http://{}/missing.png"}}]}}"#,
            image_addr
        );
        let (api_addr, api_server) =
            spawn_http_response(http_response("200 OK", "application/json", &body)).await;

        let ctx = ProviderRequestContext {
            api_key: "sk-test".to_string(),
            key_id: "key".to_string(),
            provider_id: "provider".to_string(),
            base_url: Some(format!("http://{}", api_addr)),
            api_path: None,
            proxy_config: None,
            custom_headers: None,
        };

        let err = OpenAIImagesClient::new()
            .generate(
                &ctx,
                ImageGenerateRequest {
                    model: "gpt-image-2".to_string(),
                    prompt: "生成图片".to_string(),
                    n: 1,
                    size: "auto".to_string(),
                    quality: "auto".to_string(),
                    output_format: "png".to_string(),
                    background: None,
                    output_compression: None,
                },
                None,
            )
            .await
            .expect_err("non-success image URL should be rejected");

        assert!(err.to_string().contains("Image URL returned HTTP 404"));
        api_server.await.expect("api server request");
        image_server.await.expect("image server request");
    }

    #[tokio::test]
    async fn image_url_response_rejects_non_image_body() {
        let (image_addr, image_server) =
            spawn_http_response(http_response("200 OK", "text/plain", "not an image")).await;
        let body = format!(
            r#"{{"data":[{{"url":"http://{}/image.png"}}]}}"#,
            image_addr
        );
        let (api_addr, api_server) =
            spawn_http_response(http_response("200 OK", "application/json", &body)).await;

        let ctx = ProviderRequestContext {
            api_key: "sk-test".to_string(),
            key_id: "key".to_string(),
            provider_id: "provider".to_string(),
            base_url: Some(format!("http://{}", api_addr)),
            api_path: None,
            proxy_config: None,
            custom_headers: None,
        };

        let err = OpenAIImagesClient::new()
            .generate(
                &ctx,
                ImageGenerateRequest {
                    model: "gpt-image-2".to_string(),
                    prompt: "生成图片".to_string(),
                    n: 1,
                    size: "auto".to_string(),
                    quality: "auto".to_string(),
                    output_format: "png".to_string(),
                    background: None,
                    output_compression: None,
                },
                None,
            )
            .await
            .expect_err("non-image body should be rejected");

        assert!(err
            .to_string()
            .contains("Image URL response is not a valid image"));
        api_server.await.expect("api server request");
        image_server.await.expect("image server request");
    }
}
