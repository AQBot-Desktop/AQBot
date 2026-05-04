use aqbot_core::error::Result;
use aqbot_core::types::*;
use async_trait::async_trait;
use futures::Stream;
use std::pin::Pin;

use crate::openai_compat::{OpenAICompatAdapter, OpenAICompatKind};
use crate::{ProviderAdapter, ProviderRequestContext};

pub struct DeepSeekAdapter {
    inner: OpenAICompatAdapter,
}

impl DeepSeekAdapter {
    pub fn new() -> Self {
        Self {
            inner: OpenAICompatAdapter::new(OpenAICompatKind::DeepSeek),
        }
    }
}

#[async_trait]
impl ProviderAdapter for DeepSeekAdapter {
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
