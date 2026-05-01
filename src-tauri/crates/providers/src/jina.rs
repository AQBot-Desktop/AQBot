use aqbot_core::error::{AQBotError, Result};
use aqbot_core::types::*;
use async_trait::async_trait;
use futures::{Stream, stream};
use serde::Deserialize;
use std::pin::Pin;

use crate::{ProviderAdapter, ProviderRequestContext, build_http_client};

const DEFAULT_BASE_URL: &str = "https://api.jina.ai/v1";

pub struct JinaAdapter {
    client: reqwest::Client,
}

impl JinaAdapter {
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
        "Jina provider only supports rerank in AQBot".into(),
    ))
}

pub(crate) fn jina_models(provider_id: &str) -> Vec<Model> {
    [
        "jina-reranker-v3",
        "jina-reranker-v2-base-multilingual",
        "jina-colbert-v2",
    ]
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

pub(crate) fn build_jina_rerank_body(request: &RerankRequest) -> serde_json::Value {
    serde_json::json!({
        "model": request.model,
        "query": request.query,
        "documents": request.documents,
        "top_n": request.top_n,
        "return_documents": false,
    })
}

#[derive(Deserialize)]
struct NativeRerankResponse {
    results: Vec<NativeRerankResult>,
}

#[derive(Deserialize)]
struct NativeRerankResult {
    index: usize,
    #[serde(alias = "score")]
    relevance_score: f32,
}

pub(crate) fn parse_jina_rerank_response(body: &str) -> Result<RerankResponse> {
    let parsed: NativeRerankResponse = serde_json::from_str(body)
        .map_err(|e| AQBotError::Provider(format!("Jina rerank parse error: {e}")))?;
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
impl ProviderAdapter for JinaAdapter {
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
                "Jina provider only supports rerank in AQBot".into(),
            ))
        }))
    }

    async fn list_models(&self, ctx: &ProviderRequestContext) -> Result<Vec<Model>> {
        Ok(jina_models(&ctx.provider_id))
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
                .json(&build_jina_rerank_body(&request)),
            ctx,
        )
        .send()
        .await
        .map_err(|e| AQBotError::Provider(format!("Jina rerank request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AQBotError::Provider(format!(
                "Jina rerank API error {status}: {text}"
            )));
        }

        let text = resp
            .text()
            .await
            .map_err(|e| AQBotError::Provider(format!("Jina rerank body error: {e}")))?;
        parse_jina_rerank_response(&text)
    }

    async fn validate_key(&self, ctx: &ProviderRequestContext) -> Result<bool> {
        let request = RerankRequest {
            model: "jina-reranker-v3".to_string(),
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
    fn jina_body_uses_native_top_n_and_disables_document_return() {
        let body = build_jina_rerank_body(&RerankRequest {
            model: "jina-reranker-v3".into(),
            query: "capital".into(),
            documents: vec!["doc".into()],
            top_n: 2,
        });

        assert_eq!(body["model"], "jina-reranker-v3");
        assert_eq!(body["top_n"], 2);
        assert_eq!(body["return_documents"], false);
        assert!(body.get("top_k").is_none());
    }

    #[test]
    fn jina_parser_accepts_score_alias() {
        let parsed =
            parse_jina_rerank_response(r#"{"results":[{"index":1,"score":0.87}]}"#).unwrap();

        assert_eq!(
            parsed,
            RerankResponse {
                results: vec![RerankResult {
                    index: 1,
                    relevance_score: 0.87,
                }],
            }
        );
    }
}
