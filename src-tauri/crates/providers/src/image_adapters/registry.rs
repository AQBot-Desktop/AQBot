use super::types::{
    ImageAdapter, ImageAdapterConfig, ImageModelDescriptor, ImageOperation,
    ImageParameterDescriptor, ImageParameterKind,
};
use super::{
    cancel_profile, poll_profile, submit_profile, ImageAdapterRequest, ImagePollResult,
    ImageSubmission, PendingImageSubmission,
};
use crate::ProviderRequestContext;
use aqbot_core::error::Result;
use aqbot_core::types::ProviderType;
use async_trait::async_trait;
use std::collections::HashMap;
use std::sync::Arc;

pub struct ImageAdapterRegistry {
    adapters: HashMap<&'static str, Arc<dyn ImageAdapter>>,
}

impl ImageAdapterRegistry {
    pub fn new() -> Self {
        let mut adapters: HashMap<&'static str, Arc<dyn ImageAdapter>> = HashMap::new();
        for id in [
            "openai_images",
            "xai_images",
            "glm_images",
            "siliconflow_images",
            "gemini_images",
            "generic_json",
        ] {
            adapters.insert(id, Arc::new(ProfileImageAdapter { id }));
        }
        Self { adapters }
    }

    pub fn resolve(
        &self,
        provider_type: &ProviderType,
        model_id: &str,
        config: Option<&ImageAdapterConfig>,
    ) -> Option<Arc<dyn ImageAdapter>> {
        let id = config
            .and_then(|value| value.adapter_id.as_deref())
            .unwrap_or_else(|| infer_adapter_id(provider_type, model_id));
        self.adapters.get(id).cloned()
    }

    pub fn get(&self, id: &str) -> Option<Arc<dyn ImageAdapter>> {
        self.adapters.get(id).cloned()
    }
}

impl Default for ImageAdapterRegistry {
    fn default() -> Self {
        Self::new()
    }
}

fn infer_adapter_id(provider_type: &ProviderType, model_id: &str) -> &'static str {
    match provider_type {
        ProviderType::XAI => "xai_images",
        ProviderType::GLM => "glm_images",
        ProviderType::SiliconFlow => "siliconflow_images",
        ProviderType::Gemini => "gemini_images",
        ProviderType::Custom if model_id.to_lowercase().starts_with("grok-imagine") => "xai_images",
        ProviderType::Custom | ProviderType::OpenAI => "openai_images",
        _ => "generic_json",
    }
}

struct ProfileImageAdapter {
    id: &'static str,
}

#[async_trait]
impl ImageAdapter for ProfileImageAdapter {
    fn id(&self) -> &'static str {
        self.id
    }

    fn descriptor(&self, _model_id: &str, config: &ImageAdapterConfig) -> ImageModelDescriptor {
        let profile_operations = profile_operations(self.id);
        let operations = config
            .operation_overrides
            .clone()
            .map(|overrides| {
                overrides
                    .into_iter()
                    .filter(|operation| profile_operations.contains(operation))
                    .collect()
            })
            .unwrap_or(profile_operations);
        let max_reference_images = if supports_edits(self.id)
            && operations
                .iter()
                .any(|operation| *operation != ImageOperation::Generate)
        {
            16
        } else {
            0
        };
        ImageModelDescriptor {
            adapter_id: self.id.to_string(),
            operations,
            parameters: profile_parameters(self.id),
            max_batch_size: match self.id {
                "xai_images" | "glm_images" | "gemini_images" => 1,
                "siliconflow_images" => 4,
                _ => 10,
            },
            max_reference_images,
        }
    }

    async fn submit(
        &self,
        ctx: &ProviderRequestContext,
        request: ImageAdapterRequest,
        config: &ImageAdapterConfig,
    ) -> Result<ImageSubmission> {
        submit_profile(self.id, ctx, request, config).await
    }

    async fn poll(
        &self,
        ctx: &ProviderRequestContext,
        task: &PendingImageSubmission,
        config: &ImageAdapterConfig,
    ) -> Result<ImagePollResult> {
        poll_profile(self.id, ctx, task, config).await
    }

    async fn cancel(
        &self,
        ctx: &ProviderRequestContext,
        task: &PendingImageSubmission,
        config: &ImageAdapterConfig,
    ) -> Result<()> {
        cancel_profile(self.id, ctx, task, config).await
    }
}

fn supports_edits(id: &str) -> bool {
    matches!(
        id,
        "openai_images" | "xai_images" | "gemini_images" | "generic_json"
    )
}

fn profile_operations(id: &str) -> Vec<ImageOperation> {
    match id {
        "glm_images" | "siliconflow_images" => vec![ImageOperation::Generate],
        "xai_images" | "gemini_images" => {
            vec![ImageOperation::Generate, ImageOperation::Edit]
        }
        _ => vec![
            ImageOperation::Generate,
            ImageOperation::Edit,
            ImageOperation::MaskEdit,
        ],
    }
}

fn profile_parameters(id: &str) -> Vec<ImageParameterDescriptor> {
    if id == "xai_images" {
        return vec![select_parameter(
            "aspect_ratio",
            "1:1",
            &["1:1", "16:9", "9:16", "4:3", "3:4"],
        )];
    }
    if id == "gemini_images" {
        return vec![select_parameter(
            "aspect_ratio",
            "1:1",
            &["1:1", "16:9", "9:16", "4:3", "3:4"],
        )];
    }
    let mut parameters = vec![select_parameter(
        "size",
        "auto",
        &["auto", "1024x1024", "1536x1024", "1024x1536"],
    )];
    if matches!(id, "openai_images" | "glm_images") {
        parameters.push(select_parameter(
            "quality",
            "auto",
            &["auto", "standard", "hd", "high"],
        ));
    }
    if id == "openai_images" {
        parameters.push(select_parameter(
            "output_format",
            "png",
            &["png", "jpeg", "webp"],
        ));
        parameters.push(select_parameter(
            "background",
            "auto",
            &["auto", "opaque", "transparent"],
        ));
    }
    parameters.push(number_parameter(
        "n",
        if id == "siliconflow_images" {
            4.0
        } else {
            10.0
        },
    ));
    parameters
}

fn select_parameter(key: &str, default: &str, options: &[&str]) -> ImageParameterDescriptor {
    ImageParameterDescriptor {
        key: key.into(),
        kind: ImageParameterKind::Select,
        default: default.into(),
        options: options.iter().map(|value| (*value).into()).collect(),
        min: None,
        max: None,
    }
}

fn number_parameter(key: &str, max: f64) -> ImageParameterDescriptor {
    ImageParameterDescriptor {
        key: key.into(),
        kind: ImageParameterKind::Number,
        default: 1.into(),
        options: Vec::new(),
        min: Some(1.0),
        max: Some(max),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serialized_descriptor_contains_protocol_metadata_without_display_labels() {
        let adapter = ImageAdapterRegistry::default()
            .get("openai_images")
            .expect("openai_images adapter");
        let descriptor = adapter.descriptor("gpt-image-2", &ImageAdapterConfig::default());
        let serialized = serde_json::to_value(descriptor).expect("serialize descriptor");
        let parameters = serialized["parameters"]
            .as_array()
            .expect("descriptor parameters");

        assert!(parameters
            .iter()
            .all(|parameter| parameter.get("label").is_none()));
        assert_eq!(
            parameters[0]["options"],
            serde_json::json!(["auto", "1024x1024", "1536x1024", "1024x1536"])
        );
    }
}
