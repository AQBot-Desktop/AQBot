use aqbot_core::types::{AdapterTestKinds, ModelTestKind, ProviderType};

pub fn registry_key_for_type(provider_type: &ProviderType) -> &'static str {
    match provider_type {
        ProviderType::OpenAI => "openai",
        ProviderType::OpenAIResponses => "openai_responses",
        ProviderType::DeepSeek => "deepseek",
        ProviderType::XAI => "xai",
        ProviderType::GLM => "glm",
        ProviderType::SiliconFlow => "siliconflow",
        ProviderType::Anthropic => "anthropic",
        ProviderType::Gemini => "gemini",
        ProviderType::Jina => "jina",
        ProviderType::Cohere => "cohere",
        ProviderType::Voyage => "voyage",
        ProviderType::Bedrock => "bedrock",
        ProviderType::Custom => "custom",
    }
}

pub fn adapter_test_kinds(provider_type: &str) -> &'static [ModelTestKind] {
    match provider_type {
        "jina" | "cohere" | "voyage" => &[ModelTestKind::Rerank],
        "anthropic" | "bedrock" => &[ModelTestKind::Chat],
        "siliconflow" => &[
            ModelTestKind::Chat,
            ModelTestKind::Embedding,
            ModelTestKind::Rerank,
        ],
        _ => &[ModelTestKind::Chat, ModelTestKind::Embedding],
    }
}

pub fn adapter_supports_kind(provider_type: &str, kind: ModelTestKind) -> bool {
    adapter_test_kinds(provider_type).contains(&kind)
}

pub fn all_adapter_test_kinds() -> Vec<AdapterTestKinds> {
    [
        "openai",
        "custom",
        "openai_responses",
        "deepseek",
        "xai",
        "glm",
        "siliconflow",
        "anthropic",
        "gemini",
        "jina",
        "cohere",
        "voyage",
        "bedrock",
    ]
    .into_iter()
    .map(|provider_type| AdapterTestKinds {
        provider_type: provider_type.to_string(),
        kinds: adapter_test_kinds(provider_type).to_vec(),
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bedrock_cannot_probe_embeddings() {
        assert!(!adapter_supports_kind("bedrock", ModelTestKind::Embedding));
        assert!(adapter_supports_kind("bedrock", ModelTestKind::Chat));
    }

    #[test]
    fn jina_family_only_supports_rerank() {
        assert_eq!(adapter_test_kinds("jina"), &[ModelTestKind::Rerank]);
        assert_eq!(adapter_test_kinds("cohere"), &[ModelTestKind::Rerank]);
        assert_eq!(adapter_test_kinds("voyage"), &[ModelTestKind::Rerank]);
    }
}
