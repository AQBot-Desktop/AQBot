use aqbot_core::error::Result;
use aqbot_core::types::*;
use async_trait::async_trait;
use futures::Stream;
use std::pin::Pin;

use crate::openai_compat::{OpenAICompatAdapter, OpenAICompatPolicy};
use crate::reasoning::{ReasoningStyle, ResolvedReasoning};
use crate::{ProviderAdapter, ProviderRequestContext};

pub struct XAIAdapter {
    inner: OpenAICompatAdapter<XAIPolicy>,
}

#[derive(Clone, Copy)]
pub(crate) struct XAIPolicy;

fn supports_reasoning_effort(model: &str) -> bool {
    model.to_ascii_lowercase().starts_with("grok-4.3")
}

impl OpenAICompatPolicy for XAIPolicy {
    fn default_base_url(&self) -> &'static str {
        "https://api.x.ai/v1"
    }

    fn error_label(&self) -> &'static str {
        "xAI API"
    }

    fn default_reasoning_style(&self, request: &ChatRequest) -> ReasoningStyle {
        if supports_reasoning_effort(&request.model) {
            ReasoningStyle::OpenAIReasoningEffort
        } else {
            ReasoningStyle::None
        }
    }

    fn normalize_reasoning_effort(
        &self,
        request: &ChatRequest,
        _level: &str,
        effort: String,
    ) -> Option<String> {
        if !supports_reasoning_effort(&request.model) {
            return None;
        }
        matches!(effort.as_str(), "none" | "low" | "medium" | "high").then_some(effort)
    }

    fn use_max_completion_tokens(&self, _request: &ChatRequest) -> bool {
        true
    }

    fn suppress_sampling_params(&self, _reasoning: Option<&ResolvedReasoning>) -> bool {
        false
    }
}

impl XAIAdapter {
    pub fn new() -> Self {
        Self {
            inner: OpenAICompatAdapter::new(XAIPolicy),
        }
    }
}

#[async_trait]
impl ProviderAdapter for XAIAdapter {
    async fn chat(
        &self,
        ctx: &ProviderRequestContext,
        request: ChatRequest,
    ) -> Result<ChatResponse> {
        self.inner.chat(ctx, request).await
    }

    fn chat_stream(
        &self,
        ctx: &ProviderRequestContext,
        request: ChatRequest,
    ) -> Pin<Box<dyn Stream<Item = Result<ChatStreamChunk>> + Send>> {
        self.inner.chat_stream(ctx, request)
    }

    async fn list_models(&self, ctx: &ProviderRequestContext) -> Result<Vec<Model>> {
        self.inner.list_models(ctx).await
    }

    async fn embed(
        &self,
        ctx: &ProviderRequestContext,
        request: EmbedRequest,
    ) -> Result<EmbedResponse> {
        self.inner.embed(ctx, request).await
    }

    async fn validate_key(&self, ctx: &ProviderRequestContext) -> Result<bool> {
        self.inner.validate_key(ctx).await
    }
}
