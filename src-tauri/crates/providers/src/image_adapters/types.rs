use crate::openai_images::{ImageApiOutput, ImageUpload};
use crate::ProviderRequestContext;
use aqbot_core::error::{AQBotError, Result};
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ImageOperation {
    Generate,
    Edit,
    MaskEdit,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ImageParameterKind {
    String,
    Number,
    Boolean,
    Select,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImageParameterDescriptor {
    pub key: String,
    pub kind: ImageParameterKind,
    pub default: serde_json::Value,
    #[serde(default)]
    pub options: Vec<serde_json::Value>,
    pub min: Option<f64>,
    pub max: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImageModelDescriptor {
    pub adapter_id: String,
    pub operations: Vec<ImageOperation>,
    pub parameters: Vec<ImageParameterDescriptor>,
    pub max_batch_size: u8,
    pub max_reference_images: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "snake_case")]
pub enum ImageAuthMode {
    #[default]
    Bearer,
    ApiKeyHeader,
    Query,
    None,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct GenericImageMapping {
    #[serde(default)]
    pub request_fields: BTreeMap<String, String>,
    pub images_path: Option<String>,
    pub image_url_path: Option<String>,
    pub image_base64_path: Option<String>,
    pub task_id_path: Option<String>,
    pub status_path: Option<String>,
    #[serde(default)]
    pub success_statuses: Vec<String>,
    #[serde(default)]
    pub failure_statuses: Vec<String>,
    #[serde(default)]
    pub pending_statuses: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImageAdapterConfig {
    pub adapter_id: Option<String>,
    pub endpoint: Option<String>,
    pub edit_endpoint: Option<String>,
    pub poll_endpoint: Option<String>,
    pub cancel_endpoint: Option<String>,
    #[serde(default)]
    pub auth_mode: ImageAuthMode,
    pub auth_header: Option<String>,
    #[serde(default)]
    pub extra_body: serde_json::Map<String, serde_json::Value>,
    #[serde(default)]
    pub mapping: GenericImageMapping,
    #[serde(default = "default_poll_interval")]
    pub poll_interval_secs: u64,
    #[serde(default = "default_timeout")]
    pub timeout_secs: u64,
    #[serde(default)]
    pub operation_overrides: Option<Vec<ImageOperation>>,
}

impl Default for ImageAdapterConfig {
    fn default() -> Self {
        Self {
            adapter_id: None,
            endpoint: None,
            edit_endpoint: None,
            poll_endpoint: None,
            cancel_endpoint: None,
            auth_mode: ImageAuthMode::Bearer,
            auth_header: None,
            extra_body: serde_json::Map::new(),
            mapping: GenericImageMapping::default(),
            poll_interval_secs: default_poll_interval(),
            timeout_secs: default_timeout(),
            operation_overrides: None,
        }
    }
}

impl ImageAdapterConfig {
    pub fn normalized_poll_interval(&self) -> u64 {
        self.poll_interval_secs.clamp(1, 30)
    }

    pub fn normalized_timeout(&self) -> u64 {
        self.timeout_secs.clamp(60, 24 * 60 * 60)
    }
}

fn default_poll_interval() -> u64 {
    3
}

fn default_timeout() -> u64 {
    60 * 60
}

#[derive(Debug, Clone)]
pub struct ImageAdapterRequest {
    pub operation: ImageOperation,
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
    pub parameters: serde_json::Map<String, serde_json::Value>,
}

#[derive(Debug)]
pub struct PendingImageSubmission {
    pub remote_task_id: String,
    pub remote_status: Option<String>,
    pub opaque_state: Option<serde_json::Value>,
}

#[derive(Debug)]
pub enum ImageSubmission {
    Completed(ImageApiOutput),
    Pending(PendingImageSubmission),
}

#[derive(Debug)]
pub enum ImagePollResult {
    Completed(ImageApiOutput),
    Pending(PendingImageSubmission),
    Failed(String),
}

#[async_trait]
pub trait ImageAdapter: Send + Sync {
    fn id(&self) -> &'static str;
    fn descriptor(&self, model_id: &str, config: &ImageAdapterConfig) -> ImageModelDescriptor;

    async fn submit(
        &self,
        _ctx: &ProviderRequestContext,
        _request: ImageAdapterRequest,
        _config: &ImageAdapterConfig,
    ) -> Result<ImageSubmission> {
        Err(AQBotError::Provider(format!(
            "{} does not implement image submission",
            self.id()
        )))
    }

    async fn poll(
        &self,
        _ctx: &ProviderRequestContext,
        _task: &PendingImageSubmission,
        _config: &ImageAdapterConfig,
    ) -> Result<ImagePollResult> {
        Err(AQBotError::Provider(format!(
            "{} does not support polling",
            self.id()
        )))
    }

    async fn cancel(
        &self,
        _ctx: &ProviderRequestContext,
        _task: &PendingImageSubmission,
        _config: &ImageAdapterConfig,
    ) -> Result<()> {
        Ok(())
    }
}
