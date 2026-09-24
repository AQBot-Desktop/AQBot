use aqbot_core::error::{AQBotError, Result};
use aqbot_core::types::*;
use async_trait::async_trait;
use futures::Stream;
use serde::Deserialize;
use serde_json::{Map, Value};
use std::collections::HashMap;
use std::pin::Pin;

use crate::openai_compat::{OpenAICompatAdapter, OpenAICompatPolicy};
use crate::reasoning::{ReasoningStyle, ResolvedReasoning};
use crate::{build_http_client, ProviderAdapter, ProviderRequestContext};

pub struct SiliconFlowAdapter {
    inner: OpenAICompatAdapter<SiliconFlowPolicy>,
    client: reqwest::Client,
}

#[derive(Clone, Copy)]
pub(crate) struct SiliconFlowPolicy;

impl OpenAICompatPolicy for SiliconFlowPolicy {
    fn default_base_url(&self) -> &'static str {
        "https://api.siliconflow.cn/v1"
    }

    fn error_label(&self) -> &'static str {
        "SiliconFlow API"
    }

    fn default_reasoning_style(&self, _request: &ChatRequest) -> ReasoningStyle {
        ReasoningStyle::SiliconFlowEnableThinking
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

        if let Some(enable_thinking) = reasoning.enable_thinking {
            extra.insert("enable_thinking".to_string(), Value::Bool(enable_thinking));
        }
        if let Some(thinking_budget) = reasoning.budget_tokens.filter(|v| *v > 0) {
            extra.insert(
                "thinking_budget".to_string(),
                serde_json::json!(thinking_budget),
            );
        }
        extra
    }
}

impl SiliconFlowAdapter {
    pub fn new() -> Self {
        Self {
            inner: OpenAICompatAdapter::new(SiliconFlowPolicy),
            client: crate::build_default_http_client()
                .expect("Failed to build default HTTP client"),
        }
    }

    fn base_url(ctx: &ProviderRequestContext) -> String {
        ctx.base_url
            .clone()
            .unwrap_or_else(|| SiliconFlowPolicy.default_base_url().to_string())
    }

    fn get_client(&self, ctx: &ProviderRequestContext) -> Result<reqwest::Client> {
        match &ctx.proxy_config {
            Some(c) if c.proxy_type.as_deref() != Some("none") => build_http_client(Some(c)),
            _ => Ok(self.client.clone()),
        }
    }

    async fn list_image_models(&self, ctx: &ProviderRequestContext) -> Result<Vec<Model>> {
        let response = crate::apply_request_headers(
            self.get_client(ctx)?
                .get(format!(
                    "{}/models",
                    Self::base_url(ctx).trim_end_matches('/')
                ))
                .query(&[("type", "image")])
                .bearer_auth(&ctx.api_key),
            ctx,
        )
        .send()
        .await
        .map_err(|error| {
            AQBotError::Provider(format!("SiliconFlow image model discovery failed: {error}"))
        })?;
        if !response.status().is_success() {
            let status = response.status();
            let body = response.text().await.unwrap_or_default();
            return Err(AQBotError::Provider(format!(
                "SiliconFlow image model discovery failed ({status}): {body}"
            )));
        }
        let payload: SiliconFlowModelsResponse = response.json().await.map_err(|error| {
            AQBotError::Provider(format!(
                "SiliconFlow image model discovery response was invalid: {error}"
            ))
        })?;
        Ok(parse_siliconflow_image_models(&ctx.provider_id, payload))
    }
}

fn parse_siliconflow_image_models(
    provider_id: &str,
    payload: SiliconFlowModelsResponse,
) -> Vec<Model> {
    payload
        .data
        .into_iter()
        .map(|item| Model {
            provider_id: provider_id.to_string(),
            name: item.id.clone(),
            model_id: item.id,
            group_name: Some("image".into()),
            model_type: ModelType::Image,
            capabilities: vec![],
            context_window: None,
            max_output_tokens: None,
            enabled: true,
            param_overrides: None,
            image_config: None,
            metadata_state: None,
            aliases: Vec::new(),
            icon: None,
        })
        .collect()
}

#[derive(Debug, Deserialize)]
struct SiliconFlowModelsResponse {
    #[serde(default)]
    data: Vec<SiliconFlowModelItem>,
}

#[derive(Debug, Deserialize)]
struct SiliconFlowModelItem {
    id: String,
}

fn merge_siliconflow_image_models(mut models: Vec<Model>, image_models: Vec<Model>) -> Vec<Model> {
    let mut positions = models
        .iter()
        .enumerate()
        .map(|(index, model)| (model.model_id.clone(), index))
        .collect::<HashMap<_, _>>();
    for image_model in image_models {
        if let Some(index) = positions.get(&image_model.model_id).copied() {
            models[index].model_type = ModelType::Image;
            models[index].capabilities.clear();
        } else {
            positions.insert(image_model.model_id.clone(), models.len());
            models.push(image_model);
        }
    }
    models
}

pub(crate) fn build_siliconflow_rerank_body(request: &RerankRequest) -> serde_json::Value {
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
    relevance_score: f32,
}

pub(crate) fn parse_siliconflow_rerank_response(body: &str) -> Result<RerankResponse> {
    let parsed: NativeRerankResponse = serde_json::from_str(body)
        .map_err(|e| AQBotError::Provider(format!("SiliconFlow rerank parse error: {e}")))?;
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
impl ProviderAdapter for SiliconFlowAdapter {
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
        let models = self.inner.list_models(ctx).await?;
        let image_models = match self.list_image_models(ctx).await {
            Ok(image_models) => image_models,
            Err(error) => {
                tracing::warn!("SiliconFlow image model discovery failed: {error}");
                Vec::new()
            }
        };
        Ok(merge_siliconflow_image_models(models, image_models))
    }

    async fn embed(
        &self,
        ctx: &ProviderRequestContext,
        request: EmbedRequest,
    ) -> Result<EmbedResponse> {
        self.inner.embed(ctx, request).await
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
                .json(&build_siliconflow_rerank_body(&request)),
            ctx,
        )
        .send()
        .await
        .map_err(|e| AQBotError::Provider(format!("SiliconFlow rerank request failed: {e}")))?;

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            return Err(AQBotError::Provider(format!(
                "SiliconFlow rerank API error {status}: {text}"
            )));
        }

        let text = resp
            .text()
            .await
            .map_err(|e| AQBotError::Provider(format!("SiliconFlow rerank body error: {e}")))?;
        parse_siliconflow_rerank_response(&text)
    }

    async fn validate_key(&self, ctx: &ProviderRequestContext) -> Result<bool> {
        self.inner.validate_key(ctx).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn siliconflow_body_uses_native_rerank_shape() {
        let body = build_siliconflow_rerank_body(&RerankRequest {
            model: "Qwen/Qwen3-Reranker-4B".into(),
            query: "capital".into(),
            documents: vec!["Beijing is the capital of China.".into()],
            top_n: 2,
        });

        assert_eq!(body["model"], "Qwen/Qwen3-Reranker-4B");
        assert_eq!(body["query"], "capital");
        assert_eq!(body["documents"][0], "Beijing is the capital of China.");
        assert_eq!(body["top_n"], 2);
        assert_eq!(body["return_documents"], false);
        assert!(body.get("messages").is_none());
        assert!(body.get("input").is_none());
    }

    #[test]
    fn siliconflow_parser_reads_relevance_score() {
        let parsed = parse_siliconflow_rerank_response(
            r#"{"results":[{"index":1,"relevance_score":0.88}]}"#,
        )
        .unwrap();

        assert_eq!(
            parsed,
            RerankResponse {
                results: vec![RerankResult {
                    index: 1,
                    relevance_score: 0.88,
                }],
            }
        );
    }

    #[test]
    fn official_image_model_fixture_marks_only_returned_models_as_image() {
        let parsed = parse_siliconflow_image_models(
            "siliconflow",
            SiliconFlowModelsResponse {
                data: vec![
                    SiliconFlowModelItem {
                        id: "Kwai-Kolors/Kolors".into(),
                    },
                    SiliconFlowModelItem {
                        id: "Qwen/Qwen-Image-Edit-2509".into(),
                    },
                ],
            },
        );

        assert_eq!(parsed.len(), 2);
        assert!(parsed
            .iter()
            .all(|model| model.model_type == ModelType::Image));
    }

    #[test]
    fn merge_promotes_existing_ids_and_appends_image_only_models() {
        let chat = Model {
            provider_id: "siliconflow".into(),
            model_id: "Kwai-Kolors/Kolors".into(),
            name: "Kwai-Kolors/Kolors".into(),
            group_name: None,
            model_type: ModelType::Chat,
            capabilities: vec![ModelCapability::TextChat],
            context_window: None,
            max_output_tokens: None,
            enabled: true,
            param_overrides: None,
            image_config: None,
            metadata_state: None,
            aliases: Vec::new(),
            icon: None,
        };
        let extra = Model {
            model_id: "Qwen/Qwen-Image-Edit-2509".into(),
            name: "Qwen/Qwen-Image-Edit-2509".into(),
            model_type: ModelType::Image,
            capabilities: vec![],
            group_name: Some("image".into()),
            ..chat.clone()
        };
        let merged = merge_siliconflow_image_models(
            vec![chat],
            vec![
                Model {
                    model_id: "Kwai-Kolors/Kolors".into(),
                    name: "Kwai-Kolors/Kolors".into(),
                    model_type: ModelType::Image,
                    capabilities: vec![],
                    group_name: Some("image".into()),
                    provider_id: "siliconflow".into(),
                    context_window: None,
                    max_output_tokens: None,
                    enabled: true,
                    param_overrides: None,
                    image_config: None,
                    metadata_state: None,
                    aliases: Vec::new(),
                    icon: None,
                },
                extra,
            ],
        );
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[0].model_type, ModelType::Image);
        assert_eq!(merged[1].model_id, "Qwen/Qwen-Image-Edit-2509");
        assert_eq!(merged[1].model_type, ModelType::Image);
    }
}
