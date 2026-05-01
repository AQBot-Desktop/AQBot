use std::collections::HashMap;

use crate::ProviderAdapter;
use crate::anthropic::AnthropicAdapter;
use crate::cohere::CohereAdapter;
use crate::gemini::GeminiAdapter;
use crate::jina::JinaAdapter;
use crate::openai::OpenAIAdapter;
use crate::openai_responses::OpenAIResponsesAdapter;
use crate::voyage::VoyageAdapter;

pub struct ProviderRegistry {
    adapters: HashMap<String, Box<dyn ProviderAdapter>>,
}

impl ProviderRegistry {
    pub fn new() -> Self {
        Self {
            adapters: HashMap::new(),
        }
    }

    pub fn register(&mut self, provider_type: &str, adapter: Box<dyn ProviderAdapter>) {
        self.adapters.insert(provider_type.to_string(), adapter);
    }

    pub fn get(&self, provider_type: &str) -> Option<&dyn ProviderAdapter> {
        self.adapters.get(provider_type).map(|a| a.as_ref())
    }

    /// Creates a registry pre-populated with OpenAI, Anthropic, and Gemini adapters.
    pub fn create_default() -> Self {
        let mut registry = Self::new();
        registry.register("openai", Box::new(OpenAIAdapter::new()));
        registry.register("openai_responses", Box::new(OpenAIResponsesAdapter::new()));
        registry.register("anthropic", Box::new(AnthropicAdapter::new()));
        registry.register("gemini", Box::new(GeminiAdapter::new()));
        registry.register("jina", Box::new(JinaAdapter::new()));
        registry.register("cohere", Box::new(CohereAdapter::new()));
        registry.register("voyage", Box::new(VoyageAdapter::new()));
        registry
    }
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
}
