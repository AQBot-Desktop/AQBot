use aqbot_core::error::{AQBotError, Result};
use aqbot_core::types::*;
use async_trait::async_trait;
use futures::{Stream, stream};
use serde::Deserialize;
use std::pin::Pin;

use crate::{ProviderAdapter, ProviderRequestContext, build_http_client};

const DEFAULT_BASE_URL: &str = "https://api.cohere.com/v2";

pub struct CohereAdapter {
    client: reqwest::Client,
}

impl CohereAdapter {
    pub fn new() -> Self {
        Self {
            client: crate::build_default_http_client()
                .expect("Failed to build default HTTP client"),
        }
    }

    fn base_url(ctx: &ProviderRequestContext) -> String {
        ctx.base_url
            .clone()
            .unwrap_or_else(|| DEFAULT_BASE_URL.to_string())
    }

    fn get_client(&self, ctx: &ProviderRequestContext) -> Result<reqwest::Client> {
        match &ctx.proxy_config {
            Some(c) if c.proxy_type.as_deref() != Some("none") => build_http_client(Some(c)),
            _ => Ok(self.client.clone()),
        }
    }
}

fn unsupported<T>() -> Result<T> {
    Err(AQBotError::Provider(
        "Cohere provider only supports rerank in AQBot".into(),
    ))
}

pub(crate) fn cohere_models(provider_id: &str) -> Vec<Model> {
    ["rerank-v4.0-pro", "rerank-v4.0-fast", "rerank-v3.5"]
        .into_iter()
        .map(|model_id| Model {
            provider_id: provider_id.to_string(),
            model_id: model_id.to_string(),
            name: model_id.to_string(),
            group_name: None,
            model_type: ModelType::Rerank,
            capabilities: vec![],
            max_tokens: None,
            enabled: true,
            param_overrides: None,
        })
        .collect()
}

pub(crate) fn build_cohere_rerank_body(request: &RerankRequest) -> serde_json::Value {
    serde_json::json!({
        "model": request.model,
        "query": request.query,
        "documents": request.documents,
        "top_n": request.top_n,
    })
}

#[derive(Deserialize)]
struct NativeRerankResponse {
    results: Vec<NativeRerankResult>,
}

#[derive(Deserialize)]
struct NativeRerankResult {
    index: usize,
    relevance_score: f32,
}

pub(crate) fn parse_cohere_rerank_response(body: &str) -> Result<RerankResponse> {
    let parsed: NativeRerankResponse = serde_json::from_str(body)
        .map_err(|e| AQBotError::Provider(format!("Cohere rerank parse error: {e}")))?;
    Ok(RerankResponse {
        results: parsed
            .results
            .into_iter()
            .map(|r| RerankResult {
                index: r.index,
                relevance_score: r.relevance_score,
            })
            .collect(),
    })
}

#[async_trait]
impl ProviderAdapter for CohereAdapter {
    async fn chat(
        &self,
        _ctx: &ProviderRequestContext,
        _request: ChatRequest,
    ) -> Result<ChatResponse> {
        unsupported()
    }

    fn chat_stream(
        &self,
        _ctx: &ProviderRequestContext,
        _request: ChatRequest,
    ) -> Pin<Box<dyn Stream<Item = Result<ChatStreamChunk>> + Send>> {
        Box::pin(stream::once(async {
            Err(AQBotError::Provider(
                "Cohere provider only supports rerank in AQBot".into(),
            ))
        }))
    }

    async fn list_models(&self, ctx: &ProviderRequestContext) -> Result<Vec<Model>> {
        Ok(cohere_models(&ctx.provider_id))
    }

    async fn embed(
        &self,
        _ctx: &ProviderRequestContext,
        _request: EmbedRequest,
    ) -> Result<EmbedResponse> {
        unsupported()
    }

    async fn rerank(
        &self,
        ctx: &ProviderRequestContext,
        request: RerankRequest,
    ) -> Result<RerankResponse> {
        let url = format!("{}/rerank", Self::base_url(ctx));
        let resp = crate::apply_request_headers(
            self.get_client(ctx)?
                .post(&url)
                .header("Authorization", format!("Bearer {}", ctx.api_key))
                .json(&build_cohere_rerank_body(&request)),
            ctx,
        )
        .send()
        .await
        .map_err(|e| AQBotError::Provider(format!("Cohere rerank request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AQBotError::Provider(format!(
                "Cohere rerank API error {status}: {text}"
            )));
        }

        let text = resp
            .text()
            .await
            .map_err(|e| AQBotError::Provider(format!("Cohere rerank body error: {e}")))?;
        parse_cohere_rerank_response(&text)
    }

    async fn validate_key(&self, ctx: &ProviderRequestContext) -> Result<bool> {
        let request = RerankRequest {
            model: "rerank-v4.0-fast".to_string(),
            query: "test".to_string(),
            documents: vec!["test".to_string()],
            top_n: 1,
        };
        self.rerank(ctx, request).await.map(|_| true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cohere_body_uses_native_top_n() {
        let body = build_cohere_rerank_body(&RerankRequest {
            model: "rerank-v4.0-pro".into(),
            query: "capital".into(),
            documents: vec!["doc".into()],
            top_n: 3,
        });

        assert_eq!(body["model"], "rerank-v4.0-pro");
        assert_eq!(body["query"], "capital");
        assert_eq!(body["documents"][0], "doc");
        assert_eq!(body["top_n"], 3);
        assert!(body.get("top_k").is_none());
    }

    #[test]
    fn cohere_parser_reads_relevance_score() {
        let parsed =
            parse_cohere_rerank_response(r#"{"results":[{"index":2,"relevance_score":0.91}]}"#)
                .unwrap();

        assert_eq!(
            parsed,
            RerankResponse {
                results: vec![RerankResult {
                    index: 2,
                    relevance_score: 0.91,
                }],
            }
        );
    }
}
