use std::collections::HashMap;

use crate::anthropic::AnthropicAdapter;
use crate::gemini::GeminiAdapter;
use crate::openai::OpenAIAdapter;
use crate::ProviderAdapter;

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
        registry.register("anthropic", Box::new(AnthropicAdapter::new()));
        registry.register("gemini", Box::new(GeminiAdapter::new()));
        registry
    }
}

impl Default for ProviderRegistry {
    fn default() -> Self {
        Self::new()
    }
}
