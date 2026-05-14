use aqbot_core::error::{AQBotError, Result};
use base64::Engine;
use serde::{Deserialize, Serialize};

use crate::{
    apply_request_headers, build_default_http_client, build_http_client, ProviderRequestContext,
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
        parse_response(response).await
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
                builder.body(body).header("Content-Type", "application/json")
            }
        };
        let response = apply_request_headers(builder, ctx)
            .send()
            .await
            .map_err(|e| AQBotError::Provider(format!("Image edit failed: {}", e)))?;
        parse_response(response).await
    }
}

fn image_upload_to_part(upload: ImageUpload) -> Result<reqwest::multipart::Part> {
    reqwest::multipart::Part::bytes(upload.bytes)
        .file_name(upload.file_name)
        .mime_str(&upload.mime_type)
        .map_err(|e| AQBotError::Provider(format!("Invalid image MIME type: {}", e)))
}

fn build_edit_multipart_form(request: ImageEditRequest) -> Result<reqwest::multipart::Form> {
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
        form = form.part("image[]", image_upload_to_part(upload)?);
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

fn build_edit_json_request(request: ImageEditRequest) -> Result<Vec<u8>> {
    let mut map = serde_json::Map::new();
    map.insert("model".to_string(), serde_json::Value::String(request.model));
    map.insert("prompt".to_string(), serde_json::Value::String(request.prompt));
    map.insert("n".to_string(), serde_json::Value::Number(request.n.into()));
    map.insert("size".to_string(), serde_json::Value::String(request.size));
    map.insert("quality".to_string(), serde_json::Value::String(request.quality));
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
                .map(|upload| {
                    let mut obj = serde_json::Map::new();
                    obj.insert(
                        "url".to_string(),
                        serde_json::Value::String(image_upload_to_string(upload)),
                    );
                    serde_json::Value::Object(obj)
                })
                .collect();
            map.insert(
                request.image_param_name,
                serde_json::Value::Array(images),
            );
        }
        ImageEditImageFormat::String => {
            let images: Vec<serde_json::Value> = request
                .images
                .into_iter()
                .map(|upload| serde_json::Value::String(image_upload_to_string(upload)))
                .collect();
            map.insert(
                request.image_param_name,
                serde_json::Value::Array(images),
            );
        }
    }

    if let Some(mask) = request.mask {
        map.insert(
            "mask".to_string(),
            serde_json::Value::String(image_upload_to_string(mask)),
        );
    }

    let value = serde_json::Value::Object(map);
    serde_json::to_vec(&value).map_err(|e| {
        AQBotError::Provider(format!("Failed to serialize edit request: {}", e))
    })
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

    let client = reqwest::Client::new();
    let mut images = Vec::with_capacity(body.data.len());
    for item in body.data {
        let bytes = if let Some(encoded) = item.b64_json {
            base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|e| AQBotError::Provider(format!("Invalid image b64_json: {}", e)))?
        } else if let Some(url) = item.url {
            client
                .get(&url)
                .send()
                .await
                .map_err(|e| AQBotError::Provider(format!("Failed to fetch image from URL: {}", e)))?
                .bytes()
                .await
                .map_err(|e| AQBotError::Provider(format!("Failed to read image bytes: {}", e)))?
                .to_vec()
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
    fn edit_request_body_serializes_images_as_object_array_format() {
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

        let value: serde_json::Value =
            serde_json::from_slice(&body).expect("parse json body");
        assert_eq!(value["model"], "gpt-image-2");
        assert_eq!(value["prompt"], "换成马斯克");
        assert_eq!(value["images"][0]["url"], "data:image/jpeg;base64,YWJj");
        assert!(value.get("mask").is_none());

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

        let value: serde_json::Value =
            serde_json::from_slice(&body).expect("parse json body");
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
    fn edit_request_body_serializes_multiple_images_and_mask_as_data_urls() {
        let body = build_edit_json_request(ImageEditRequest {
            model: "gpt-image-2".to_string(),
            prompt: "只替换遮罩区域".to_string(),
            n: 1,
            size: "auto".to_string(),
            quality: "auto".to_string(),
            output_format: "webp".to_string(),
            background: None,
            output_compression: Some(80),
            transfer_mode: ImageEditTransferMode::Base64,
            image_format: ImageEditImageFormat::String,
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

        let value: serde_json::Value =
            serde_json::from_slice(&body).expect("parse json body");
        assert_eq!(
            value["images"].as_array().expect("images array").len(),
            2
        );
        assert_eq!(value["images"][0], "data:image/png;base64,c291cmNl");
        assert_eq!(value["images"][1], "data:image/webp;base64,cmVm");
        assert_eq!(value["mask"], "data:image/png;base64,bWFzaw==");
        assert_eq!(value["output_compression"], 80);
        assert!(value.get("background").is_none());

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

        let value: serde_json::Value =
            serde_json::from_slice(&body).expect("parse json body");
        assert!(value.get("image_urls").is_some());
        assert!(value.get("images").is_none());
        assert_eq!(value["image_urls"][0], "data:image/jpeg;base64,dGVzdA==");
    }

    #[tokio::test]
    async fn edit_sends_multipart_body_when_requested() {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};

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

            let body = r#"{"data":[{"b64_json":"aW1n"}]}"#;
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{}",
                body.len(),
                body
            );
            socket
                .write_all(response.as_bytes())
                .await
                .expect("write response");

            String::from_utf8_lossy(&request).into_owned()
        });

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
                    image_param_name: "images".to_string(),
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
        assert!(request.contains("filename=\"reference.jpg\""));
        assert!(!request.contains("data:image/jpeg;base64"));
    }
}
