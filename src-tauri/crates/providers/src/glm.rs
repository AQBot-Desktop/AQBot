use aqbot_core::error::Result;
use aqbot_core::types::*;
use async_trait::async_trait;
use futures::Stream;
use serde_json::{Map, Value};
use std::pin::Pin;

use crate::openai_compat::{OpenAICompatAdapter, OpenAICompatPolicy};
use crate::reasoning::{ReasoningStyle, ResolvedReasoning};
use crate::{ProviderAdapter, ProviderRequestContext};

pub struct GLMAdapter {
    inner: OpenAICompatAdapter<GLMPolicy>,
}

#[derive(Clone, Copy)]
pub(crate) struct GLMPolicy;

impl OpenAICompatPolicy for GLMPolicy {
    fn default_base_url(&self) -> &'static str {
        "https://open.bigmodel.cn/api/paas/v4"
    }

    fn error_label(&self) -> &'static str {
        "GLM API"
    }

    fn default_reasoning_style(&self, _request: &ChatRequest) -> ReasoningStyle {
        ReasoningStyle::GlmThinking
    }

    fn normalize_reasoning_effort(
        &self,
        _request: &ChatRequest,
        _level: &str,
        _effort: String,
    ) -> Option<String> {
        None
    }

    fn use_max_completion_tokens(&self, _request: &ChatRequest) -> bool {
        false
    }

    fn extra_body_fields(&self, reasoning: Option<&ResolvedReasoning>) -> Map<String, Value> {
        let mut extra = Map::new();
        let Some(reasoning) = reasoning else {
            return extra;
        };

        let thinking_type = if matches!(reasoning.level.as_str(), "off" | "none") {
            "disabled"
        } else {
            "enabled"
        };
        extra.insert(
            "thinking".to_string(),
            serde_json::json!({
                "type": thinking_type,
                "clear_thinking": true,
            }),
        );
        extra
    }
}

impl GLMAdapter {
    pub fn new() -> Self {
        Self {
            inner: OpenAICompatAdapter::new(GLMPolicy),
        }
    }
}

#[async_trait]
impl ProviderAdapter for GLMAdapter {
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
