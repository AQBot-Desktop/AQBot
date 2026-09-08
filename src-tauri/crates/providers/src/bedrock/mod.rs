mod client;
mod convert;

use std::collections::BTreeMap;
use std::pin::Pin;

use aqbot_core::error::{AQBotError, Result};
use aqbot_core::types::{
    ChatFinishReason, ChatRequest, ChatResponse, ChatStreamChunk, EmbedRequest, EmbedResponse,
    Model, TokenUsage, ToolCall, ToolCallFunction,
};
use async_trait::async_trait;
use aws_sdk_bedrockruntime::types::{
    ContentBlockDelta, ContentBlockStart, ConverseOutput, ConverseStreamOutput,
};
use futures::channel::mpsc;
use futures::Stream;

use self::client::BedrockClients;
use self::convert::{convert_request, foundation_model, parse_response_content, usage};
use crate::{
    incomplete_stream_error, spawn_abortable_stream, ProviderAdapter, ProviderRequestContext,
};

pub struct BedrockAdapter {
    disable_retries: bool,
}

impl BedrockAdapter {
    pub fn new() -> Self {
        Self {
            disable_retries: false,
        }
    }

    pub fn without_retries() -> Self {
        Self {
            disable_retries: true,
        }
    }
}

impl Default for BedrockAdapter {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait]
impl ProviderAdapter for BedrockAdapter {
    async fn chat(
        &self,
        ctx: &ProviderRequestContext,
        request: ChatRequest,
    ) -> Result<ChatResponse> {
        let clients = BedrockClients::from_context(ctx, self.disable_retries).await?;
        let converted = convert_request(&request)?;
        let response = clients
            .runtime
            .converse()
            .model_id(&request.model)
            .set_system(converted.system)
            .set_messages(Some(converted.messages))
            .set_inference_config(converted.inference)
            .set_tool_config(converted.tools)
            .send()
            .await
            .map_err(aws_error)?;
        response_to_chat(&request.model, response.output(), response.usage())
    }

    fn chat_stream(
        &self,
        ctx: &ProviderRequestContext,
        request: ChatRequest,
    ) -> Pin<Box<dyn Stream<Item = Result<ChatStreamChunk>> + Send>> {
        let ctx = ctx.clone();
        let disable_retries = self.disable_retries;
        spawn_abortable_stream(move |tx| async move {
            if let Err(error) = run_stream(ctx, request, &tx, disable_retries).await {
                let _ = tx.unbounded_send(Err(error));
            }
        })
    }

    async fn list_models(&self, ctx: &ProviderRequestContext) -> Result<Vec<Model>> {
        let clients = BedrockClients::from_context(ctx, self.disable_retries).await?;
        let response = clients
            .control
            .list_foundation_models()
            .send()
            .await
            .map_err(aws_error)?;
        Ok(response
            .model_summaries()
            .iter()
            .filter_map(|summary| foundation_model(summary, ctx))
            .collect())
    }

    async fn embed(
        &self,
        _ctx: &ProviderRequestContext,
        _request: EmbedRequest,
    ) -> Result<EmbedResponse> {
        Err(AQBotError::Provider(
            "AWS Bedrock embeddings are not supported".into(),
        ))
    }
}

async fn run_stream(
    ctx: ProviderRequestContext,
    request: ChatRequest,
    tx: &mpsc::UnboundedSender<Result<ChatStreamChunk>>,
    disable_retries: bool,
) -> Result<()> {
    let clients = BedrockClients::from_context(&ctx, disable_retries).await?;
    let converted = convert_request(&request)?;
    let mut response = clients
        .runtime
        .converse_stream()
        .model_id(&request.model)
        .set_system(converted.system)
        .set_messages(Some(converted.messages))
        .set_inference_config(converted.inference)
        .set_tool_config(converted.tools)
        .send()
        .await
        .map_err(aws_error)?;
    let mut accumulator = StreamAccumulator::default();
    while let Some(event) = response
        .stream
        .recv()
        .await
        .map_err(|error| AQBotError::Provider(format!("Bedrock stream failed: {error}")))?
    {
        if let Some(chunk) = accumulator.apply(event)? {
            tx.unbounded_send(Ok(chunk))
                .map_err(|_| AQBotError::Provider("Bedrock stream receiver closed".into()))?;
        }
    }
    tx.unbounded_send(Ok(accumulator.finish()?))
        .map_err(|_| AQBotError::Provider("Bedrock stream receiver closed".into()))
}

fn response_to_chat(
    model: &str,
    output: Option<&ConverseOutput>,
    token_usage: Option<&aws_sdk_bedrockruntime::types::TokenUsage>,
) -> Result<ChatResponse> {
    let message = output
        .and_then(|output| output.as_message().ok())
        .ok_or_else(|| AQBotError::Provider("Bedrock returned no message output".into()))?;
    let (content, tool_calls) = parse_response_content(message.content())?;
    Ok(ChatResponse {
        id: format!("bedrock-{model}"),
        model: model.to_owned(),
        content,
        thinking: None,
        usage: usage(token_usage),
        tool_calls,
    })
}

#[derive(Default)]
struct StreamAccumulator {
    tools: BTreeMap<i32, PendingTool>,
    usage: Option<TokenUsage>,
    saw_message_stop: bool,
    finish_reason: Option<ChatFinishReason>,
}

struct PendingTool {
    id: String,
    name: String,
    arguments: String,
}

impl StreamAccumulator {
    fn apply(&mut self, event: ConverseStreamOutput) -> Result<Option<ChatStreamChunk>> {
        match event {
            ConverseStreamOutput::ContentBlockStart(event) => {
                self.start(event.content_block_index(), event.start())?;
                Ok(None)
            }
            ConverseStreamOutput::ContentBlockDelta(event) => {
                self.delta(event.content_block_index(), event.delta())
            }
            ConverseStreamOutput::Metadata(event) => {
                if let Some(value) = event.usage() {
                    self.usage = Some(usage(Some(value)));
                }
                Ok(None)
            }
            ConverseStreamOutput::MessageStop(event) => {
                self.saw_message_stop = true;
                self.finish_reason =
                    Some(ChatFinishReason::from_bedrock(event.stop_reason().as_str()));
                Ok(None)
            }
            ConverseStreamOutput::ContentBlockStop(_) | ConverseStreamOutput::MessageStart(_) => {
                Ok(None)
            }
            _ => Err(AQBotError::Provider(
                "Bedrock returned an unknown stream event".into(),
            )),
        }
    }

    fn start(&mut self, index: i32, start: Option<&ContentBlockStart>) -> Result<()> {
        match start {
            Some(ContentBlockStart::ToolUse(tool)) => {
                self.tools.insert(
                    index,
                    PendingTool {
                        id: tool.tool_use_id().to_owned(),
                        name: tool.name().to_owned(),
                        arguments: String::new(),
                    },
                );
                Ok(())
            }
            None => Ok(()),
            _ => Err(AQBotError::Provider(
                "AWS Bedrock does not support this stream content block".into(),
            )),
        }
    }

    fn delta(
        &mut self,
        index: i32,
        delta: Option<&ContentBlockDelta>,
    ) -> Result<Option<ChatStreamChunk>> {
        match delta {
            Some(ContentBlockDelta::Text(text)) => Ok(Some(ChatStreamChunk {
                content: Some(text.clone()),
                thinking: None,
                done: false,
                is_final: None,
                usage: None,
                tool_calls: None,
                finish_reason: None,
            })),
            Some(ContentBlockDelta::ToolUse(tool)) => {
                let pending = self.tools.get_mut(&index).ok_or_else(|| {
                    AQBotError::Provider("Bedrock tool delta arrived before tool start".into())
                })?;
                pending.arguments.push_str(tool.input());
                Ok(None)
            }
            Some(ContentBlockDelta::ReasoningContent(_)) => Err(AQBotError::Provider(
                "AWS Bedrock does not support reasoning content persistence".into(),
            )),
            None => Ok(None),
            _ => Err(AQBotError::Provider(
                "AWS Bedrock does not support this stream delta".into(),
            )),
        }
    }

    fn finish(self) -> Result<ChatStreamChunk> {
        if !self.saw_message_stop {
            return Err(incomplete_stream_error());
        }
        let tool_calls = self
            .tools
            .into_values()
            .map(|tool| {
                let value: serde_json::Value =
                    serde_json::from_str(&tool.arguments).map_err(|error| {
                        AQBotError::Provider(format!(
                            "Bedrock returned invalid tool arguments: {error}"
                        ))
                    })?;
                Ok(ToolCall {
                    id: tool.id,
                    call_type: "function".into(),
                    function: ToolCallFunction {
                        name: tool.name,
                        arguments: serde_json::to_string(&value)
                            .map_err(|error| AQBotError::Provider(error.to_string()))?,
                    },
                })
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(ChatStreamChunk {
            content: None,
            thinking: None,
            done: true,
            is_final: None,
            usage: self.usage,
            tool_calls: (!tool_calls.is_empty()).then_some(tool_calls),
            finish_reason: self.finish_reason,
        })
    }
}

fn aws_error(error: impl std::fmt::Display) -> AQBotError {
    AQBotError::Provider(format!("AWS Bedrock request failed: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aws_sdk_bedrockruntime::types::{
        ContentBlockDeltaEvent, ContentBlockStartEvent, ToolUseBlockDelta, ToolUseBlockStart,
    };

    #[test]
    fn stream_accumulator_assembles_text_and_tool_arguments_by_block_index() {
        let mut accumulator = StreamAccumulator::default();
        let text = ContentBlockDeltaEvent::builder()
            .content_block_index(0)
            .delta(ContentBlockDelta::Text("Hello".into()))
            .build()
            .unwrap();
        let text_chunk = accumulator
            .apply(ConverseStreamOutput::ContentBlockDelta(text))
            .unwrap()
            .unwrap();
        assert_eq!(text_chunk.content.as_deref(), Some("Hello"));

        let start = ToolUseBlockStart::builder()
            .tool_use_id("tool-1")
            .name("weather")
            .build()
            .unwrap();
        let start = ContentBlockStartEvent::builder()
            .content_block_index(1)
            .start(ContentBlockStart::ToolUse(start))
            .build()
            .unwrap();
        accumulator
            .apply(ConverseStreamOutput::ContentBlockStart(start))
            .unwrap();
        for value in ["{\"city\":\"", "Tokyo\"}"] {
            let delta = ToolUseBlockDelta::builder().input(value).build().unwrap();
            let event = ContentBlockDeltaEvent::builder()
                .content_block_index(1)
                .delta(ContentBlockDelta::ToolUse(delta))
                .build()
                .unwrap();
            accumulator
                .apply(ConverseStreamOutput::ContentBlockDelta(event))
                .unwrap();
        }

        let stop = aws_sdk_bedrockruntime::types::MessageStopEvent::builder()
            .stop_reason(aws_sdk_bedrockruntime::types::StopReason::ToolUse)
            .build()
            .unwrap();
        accumulator
            .apply(ConverseStreamOutput::MessageStop(stop))
            .unwrap();
        let final_chunk = accumulator.finish().unwrap();
        assert!(final_chunk.done);
        let tool_call = &final_chunk.tool_calls.unwrap()[0];
        assert_eq!(tool_call.id, "tool-1");
        assert_eq!(tool_call.function.arguments, r#"{"city":"Tokyo"}"#);
    }

    #[test]
    fn stream_accumulator_requires_stop_and_keeps_metadata_after_stop() {
        assert!(StreamAccumulator::default()
            .finish()
            .unwrap_err()
            .to_string()
            .contains("terminal event"));
        let mut accumulator = StreamAccumulator::default();
        let stop = aws_sdk_bedrockruntime::types::MessageStopEvent::builder()
            .stop_reason(aws_sdk_bedrockruntime::types::StopReason::EndTurn)
            .build()
            .unwrap();
        accumulator
            .apply(ConverseStreamOutput::MessageStop(stop))
            .unwrap();
        let token_usage = aws_sdk_bedrockruntime::types::TokenUsage::builder()
            .input_tokens(3)
            .output_tokens(2)
            .total_tokens(5)
            .build()
            .unwrap();
        let metadata = aws_sdk_bedrockruntime::types::ConverseStreamMetadataEvent::builder()
            .usage(token_usage)
            .build();
        accumulator
            .apply(ConverseStreamOutput::Metadata(metadata))
            .unwrap();
        accumulator
            .apply(ConverseStreamOutput::Metadata(
                aws_sdk_bedrockruntime::types::ConverseStreamMetadataEvent::builder().build(),
            ))
            .unwrap();
        let final_chunk = accumulator.finish().unwrap();
        assert_eq!(final_chunk.finish_reason, Some(ChatFinishReason::Stop));
        assert_eq!(final_chunk.usage.unwrap().total_tokens, 5);
    }

    #[test]
    fn stream_accumulator_rejects_tool_delta_without_start() {
        let delta = ToolUseBlockDelta::builder()
            .input(r#"{"city":"Tokyo"}"#)
            .build()
            .unwrap();
        let event = ContentBlockDeltaEvent::builder()
            .content_block_index(3)
            .delta(ContentBlockDelta::ToolUse(delta))
            .build()
            .unwrap();
        let error = StreamAccumulator::default()
            .apply(ConverseStreamOutput::ContentBlockDelta(event))
            .unwrap_err();

        assert!(error.to_string().contains("before tool start"));
    }
}
