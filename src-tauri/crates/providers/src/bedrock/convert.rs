use std::collections::HashMap;

use aqbot_core::error::{AQBotError, Result};
use aqbot_core::types::{
    ChatContent, ChatMessage, ChatRequest, ChatTool, Model, ModelCapability, ModelType, TokenUsage,
    ToolCall, ToolCallFunction,
};
use aws_sdk_bedrock::types::{FoundationModelSummary, ModelModality};
use aws_sdk_bedrockruntime::primitives::Blob;
use aws_sdk_bedrockruntime::types::{
    ContentBlock, ConversationRole, ImageBlock, ImageFormat, ImageSource, InferenceConfiguration,
    Message, SystemContentBlock, Tool, ToolConfiguration, ToolInputSchema, ToolResultBlock,
    ToolResultContentBlock, ToolSpecification, ToolUseBlock,
};
use aws_smithy_types::{Document, Number};
use base64::Engine;

use crate::{parse_base64_data_url, ProviderRequestContext};

pub(super) struct BedrockRequest {
    pub system: Option<Vec<SystemContentBlock>>,
    pub messages: Vec<Message>,
    pub inference: Option<InferenceConfiguration>,
    pub tools: Option<ToolConfiguration>,
}

pub(super) fn convert_request(request: &ChatRequest) -> Result<BedrockRequest> {
    validate_request_options(request)?;
    let (system, messages) = convert_messages(&request.messages)?;
    Ok(BedrockRequest {
        system,
        messages,
        inference: convert_inference(request)?,
        tools: convert_tools(request.tools.as_deref())?,
    })
}

fn validate_request_options(request: &ChatRequest) -> Result<()> {
    if request.thinking_budget.is_some()
        || request.thinking_level.is_some()
        || request.reasoning_profile.is_some()
    {
        return Err(unsupported("extended thinking"));
    }
    if request
        .extra_body
        .as_ref()
        .is_some_and(|body| !body.is_empty())
    {
        return Err(unsupported("extra_body"));
    }
    Ok(())
}

fn convert_messages(
    messages: &[ChatMessage],
) -> Result<(Option<Vec<SystemContentBlock>>, Vec<Message>)> {
    let mut system = Vec::new();
    let mut grouped = Vec::<(ConversationRole, Vec<ContentBlock>)>::new();
    for message in messages {
        if message.role == "system" {
            system.extend(system_blocks(&message.content)?);
        } else {
            let (role, content) = convert_message_blocks(message)?;
            if let Some((previous_role, previous_content)) = grouped.last_mut() {
                if previous_role == &role {
                    previous_content.extend(content);
                    continue;
                }
            }
            grouped.push((role, content));
        }
    }
    let converted = grouped
        .into_iter()
        .map(|(role, content)| {
            Message::builder()
                .role(role)
                .set_content(Some(content))
                .build()
                .map_err(build_error)
        })
        .collect::<Result<Vec<_>>>()?;
    Ok(((!system.is_empty()).then_some(system), converted))
}

fn system_blocks(content: &ChatContent) -> Result<Vec<SystemContentBlock>> {
    match content {
        ChatContent::Text(text) => Ok(vec![SystemContentBlock::Text(text.clone())]),
        ChatContent::Multipart(parts) => parts
            .iter()
            .map(|part| {
                part.text
                    .clone()
                    .map(SystemContentBlock::Text)
                    .ok_or_else(|| unsupported("images in system messages"))
            })
            .collect(),
    }
}

fn convert_message_blocks(message: &ChatMessage) -> Result<(ConversationRole, Vec<ContentBlock>)> {
    let (role, mut content) = match message.role.as_str() {
        "user" => (
            ConversationRole::User,
            content_blocks(&message.content, true)?,
        ),
        "assistant" => (
            ConversationRole::Assistant,
            content_blocks(&message.content, false)?,
        ),
        "tool" => (ConversationRole::User, vec![tool_result_block(message)?]),
        role => {
            return Err(AQBotError::Validation(format!(
                "Unsupported Bedrock message role: {role}"
            )))
        }
    };

    if message.reasoning_content.is_some() {
        return Err(unsupported("reasoning content persistence"));
    }
    if let Some(tool_calls) = &message.tool_calls {
        if message.role != "assistant" {
            return Err(AQBotError::Validation(
                "Tool calls are only valid on assistant messages".into(),
            ));
        }
        content.retain(|block| !matches!(block, ContentBlock::Text(text) if text.is_empty()));
        content.extend(
            tool_calls
                .iter()
                .map(tool_use_block)
                .collect::<Result<Vec<_>>>()?,
        );
    }
    Ok((role, content))
}

fn content_blocks(content: &ChatContent, allow_images: bool) -> Result<Vec<ContentBlock>> {
    match content {
        ChatContent::Text(text) => Ok(vec![ContentBlock::Text(text.clone())]),
        ChatContent::Multipart(parts) => parts
            .iter()
            .map(|part| {
                if let Some(text) = &part.text {
                    return Ok(ContentBlock::Text(text.clone()));
                }
                let image = part.image_url.as_ref().ok_or_else(|| {
                    AQBotError::Validation("Bedrock content part has no supported content".into())
                })?;
                if !allow_images {
                    return Err(unsupported("images in assistant messages"));
                }
                image_block(&image.url)
            })
            .collect(),
    }
}

fn image_block(url: &str) -> Result<ContentBlock> {
    let (mime, encoded) = parse_base64_data_url(url)
        .ok_or_else(|| unsupported("remote image URLs; use a Base64 data URL"))?;
    let format = match mime.as_str() {
        "image/jpeg" | "image/jpg" => ImageFormat::Jpeg,
        "image/png" => ImageFormat::Png,
        "image/gif" => ImageFormat::Gif,
        "image/webp" => ImageFormat::Webp,
        _ => {
            return Err(AQBotError::Validation(format!(
                "Unsupported Bedrock image MIME type: {mime}"
            )))
        }
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .map_err(|_| AQBotError::Validation("Invalid Base64 image data".into()))?;
    let image = ImageBlock::builder()
        .format(format)
        .source(ImageSource::Bytes(Blob::new(bytes)))
        .build()
        .map_err(build_error)?;
    Ok(ContentBlock::Image(image))
}

fn tool_use_block(tool_call: &ToolCall) -> Result<ContentBlock> {
    let input: serde_json::Value = serde_json::from_str(&tool_call.function.arguments)
        .map_err(|error| AQBotError::Validation(format!("Invalid tool arguments JSON: {error}")))?;
    let block = ToolUseBlock::builder()
        .tool_use_id(tool_call.id.clone())
        .name(tool_call.function.name.clone())
        .input(json_to_document(&input)?)
        .build()
        .map_err(build_error)?;
    Ok(ContentBlock::ToolUse(block))
}

fn tool_result_block(message: &ChatMessage) -> Result<ContentBlock> {
    let tool_use_id = message
        .tool_call_id
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AQBotError::Validation("Tool result is missing tool_call_id".into()))?;
    let result = ToolResultBlock::builder()
        .tool_use_id(tool_use_id)
        .content(ToolResultContentBlock::Text(extract_text(
            &message.content,
        )?))
        .build()
        .map_err(build_error)?;
    Ok(ContentBlock::ToolResult(result))
}

fn extract_text(content: &ChatContent) -> Result<String> {
    match content {
        ChatContent::Text(text) => Ok(text.clone()),
        ChatContent::Multipart(parts) => parts
            .iter()
            .map(|part| {
                part.text
                    .clone()
                    .ok_or_else(|| unsupported("images in tool results"))
            })
            .collect::<Result<Vec<_>>>()
            .map(|parts| parts.join("\n")),
    }
}

fn convert_inference(request: &ChatRequest) -> Result<Option<InferenceConfiguration>> {
    if request.max_tokens.is_none() && request.temperature.is_none() && request.top_p.is_none() {
        return Ok(None);
    }
    let max_tokens = request
        .max_tokens
        .map(|value| {
            i32::try_from(value)
                .map_err(|_| AQBotError::Validation("max_tokens exceeds Bedrock limit".into()))
        })
        .transpose()?;
    let inference = InferenceConfiguration::builder()
        .set_max_tokens(max_tokens)
        .set_temperature(optional_f32(request.temperature, "temperature")?)
        .set_top_p(optional_f32(request.top_p, "top_p")?)
        .build();
    Ok(Some(inference))
}

fn optional_f32(value: Option<f64>, field: &str) -> Result<Option<f32>> {
    value
        .map(|value| {
            if !value.is_finite() || value < f32::MIN as f64 || value > f32::MAX as f64 {
                Err(AQBotError::Validation(format!(
                    "{field} is outside the supported range"
                )))
            } else {
                Ok(value as f32)
            }
        })
        .transpose()
}

fn convert_tools(tools: Option<&[ChatTool]>) -> Result<Option<ToolConfiguration>> {
    let Some(tools) = tools.filter(|tools| !tools.is_empty()) else {
        return Ok(None);
    };
    let tools = tools
        .iter()
        .map(|tool| {
            if tool.r#type != "function" {
                return Err(AQBotError::Validation(format!(
                    "Unsupported Bedrock tool type: {}",
                    tool.r#type
                )));
            }
            let schema = tool
                .function
                .parameters
                .clone()
                .unwrap_or_else(|| serde_json::json!({"type": "object"}));
            let specification = ToolSpecification::builder()
                .name(tool.function.name.clone())
                .set_description(tool.function.description.clone())
                .input_schema(ToolInputSchema::Json(json_to_document(&schema)?))
                .build()
                .map_err(build_error)?;
            Ok(Tool::ToolSpec(specification))
        })
        .collect::<Result<Vec<_>>>()?;
    ToolConfiguration::builder()
        .set_tools(Some(tools))
        .build()
        .map(Some)
        .map_err(build_error)
}

pub(super) fn parse_response_content(
    content: &[ContentBlock],
) -> Result<(String, Option<Vec<ToolCall>>)> {
    let mut text = String::new();
    let mut tools = Vec::new();
    for block in content {
        match block {
            ContentBlock::Text(value) => text.push_str(value),
            ContentBlock::ToolUse(tool) => tools.push(ToolCall {
                id: tool.tool_use_id().to_owned(),
                call_type: "function".into(),
                function: ToolCallFunction {
                    name: tool.name().to_owned(),
                    arguments: serde_json::to_string(&document_to_json(tool.input()))
                        .map_err(|error| AQBotError::Provider(error.to_string()))?,
                },
            }),
            ContentBlock::ReasoningContent(_) => {
                return Err(unsupported("reasoning content persistence"))
            }
            _ => return Err(unsupported("this response content block")),
        }
    }
    Ok((text, (!tools.is_empty()).then_some(tools)))
}

pub(super) fn usage(usage: Option<&aws_sdk_bedrockruntime::types::TokenUsage>) -> TokenUsage {
    usage
        .map(|usage| TokenUsage {
            prompt_tokens: non_negative(usage.input_tokens()),
            completion_tokens: non_negative(usage.output_tokens()),
            total_tokens: non_negative(usage.total_tokens()),
        })
        .unwrap_or(TokenUsage {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        })
}

pub(super) fn foundation_model(
    summary: &FoundationModelSummary,
    ctx: &ProviderRequestContext,
) -> Option<Model> {
    let is_active = summary
        .model_lifecycle()
        .is_some_and(|lifecycle| lifecycle.status().as_str() == "ACTIVE");
    let text_output = summary
        .output_modalities()
        .iter()
        .any(|modality| modality == &ModelModality::Text);
    if !is_active || !text_output || summary.response_streaming_supported() != Some(true) {
        return None;
    }
    let mut capabilities = vec![ModelCapability::TextChat];
    if summary
        .input_modalities()
        .iter()
        .any(|modality| modality == &ModelModality::Image)
    {
        capabilities.push(ModelCapability::Vision);
    }
    Some(Model {
        provider_id: ctx.provider_id.clone(),
        model_id: summary.model_id().to_owned(),
        name: summary
            .model_name()
            .unwrap_or(summary.model_id())
            .to_owned(),
        group_name: summary.provider_name().map(str::to_owned),
        model_type: ModelType::Chat,
        capabilities,
        context_window: None,
        max_output_tokens: None,
        enabled: true,
        param_overrides: None,
        image_config: None,
        metadata_state: None,
        aliases: Vec::new(),
        icon: None,
    })
}

pub(super) fn json_to_document(value: &serde_json::Value) -> Result<Document> {
    Ok(match value {
        serde_json::Value::Null => Document::Null,
        serde_json::Value::Bool(value) => Document::Bool(*value),
        serde_json::Value::String(value) => Document::String(value.clone()),
        serde_json::Value::Array(values) => Document::Array(
            values
                .iter()
                .map(json_to_document)
                .collect::<Result<Vec<_>>>()?,
        ),
        serde_json::Value::Object(values) => Document::Object(
            values
                .iter()
                .map(|(key, value)| Ok((key.clone(), json_to_document(value)?)))
                .collect::<Result<HashMap<_, _>>>()?,
        ),
        serde_json::Value::Number(value) => {
            let number = if let Some(value) = value.as_u64() {
                Number::PosInt(value)
            } else if let Some(value) = value.as_i64() {
                Number::NegInt(value)
            } else {
                Number::Float(
                    value
                        .as_f64()
                        .ok_or_else(|| AQBotError::Validation("Unsupported JSON number".into()))?,
                )
            };
            Document::Number(number)
        }
    })
}

fn document_to_json(document: &Document) -> serde_json::Value {
    match document {
        Document::Null => serde_json::Value::Null,
        Document::Bool(value) => serde_json::Value::Bool(*value),
        Document::String(value) => serde_json::Value::String(value.clone()),
        Document::Array(values) => {
            serde_json::Value::Array(values.iter().map(document_to_json).collect())
        }
        Document::Object(values) => serde_json::Value::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), document_to_json(value)))
                .collect(),
        ),
        Document::Number(Number::PosInt(value)) => (*value).into(),
        Document::Number(Number::NegInt(value)) => (*value).into(),
        Document::Number(Number::Float(value)) => serde_json::Number::from_f64(*value)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
    }
}

fn non_negative(value: i32) -> u32 {
    u32::try_from(value).unwrap_or(0)
}

fn unsupported(feature: &str) -> AQBotError {
    AQBotError::Provider(format!("AWS Bedrock does not support {feature}"))
}

fn build_error(error: impl std::fmt::Display) -> AQBotError {
    AQBotError::Provider(format!("Failed to build Bedrock request: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use aqbot_core::types::{ChatToolFunction, ContentPart, ImageUrl, ProviderProxyConfig};
    use aws_sdk_bedrock::types::{FoundationModelLifecycle, FoundationModelLifecycleStatus};

    fn request(messages: Vec<ChatMessage>) -> ChatRequest {
        ChatRequest {
            model: "anthropic.claude-test".into(),
            messages,
            stream: false,
            temperature: Some(0.5),
            top_p: Some(0.9),
            max_tokens: Some(1024),
            tools: None,
            thinking_budget: None,
            thinking_level: None,
            reasoning_profile: None,
            use_max_completion_tokens: None,
            thinking_param_style: None,
            extra_body: None,
        }
    }

    fn message(role: &str, content: ChatContent) -> ChatMessage {
        ChatMessage {
            role: role.into(),
            content,
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        }
    }

    fn context() -> ProviderRequestContext {
        ProviderRequestContext {
            api_key: String::new(),
            key_id: String::new(),
            provider_id: "bedrock-provider".into(),
            base_url: None,
            api_path: None,
            aws_region: Some("us-east-1".into()),
            proxy_config: Some(ProviderProxyConfig {
                proxy_type: None,
                proxy_address: None,
                proxy_port: None,
            }),
            custom_headers: None,
        }
    }

    #[test]
    fn converts_system_text_and_base64_image() {
        let converted = convert_request(&request(vec![
            message("system", ChatContent::Text("Be concise".into())),
            message(
                "user",
                ChatContent::Multipart(vec![
                    ContentPart {
                        r#type: "text".into(),
                        text: Some("Describe".into()),
                        image_url: None,
                    },
                    ContentPart {
                        r#type: "image_url".into(),
                        text: None,
                        image_url: Some(ImageUrl {
                            url: "data:image/png;base64,YWJj".into(),
                        }),
                    },
                ]),
            ),
        ]))
        .unwrap();

        assert!(matches!(
            converted.system.as_deref(),
            Some([SystemContentBlock::Text(text)]) if text == "Be concise"
        ));
        assert!(matches!(
            converted.messages[0].content(),
            [ContentBlock::Text(text), ContentBlock::Image(_)] if text == "Describe"
        ));
        assert_eq!(converted.inference.unwrap().max_tokens(), Some(1024));
    }

    #[test]
    fn converts_tools_tool_calls_and_results() {
        let user = message("user", ChatContent::Text("Weather?".into()));
        let mut assistant = message("assistant", ChatContent::Text(String::new()));
        assistant.tool_calls = Some(vec![
            ToolCall {
                id: "tool-1".into(),
                call_type: "function".into(),
                function: ToolCallFunction {
                    name: "weather".into(),
                    arguments: r#"{"city":"Tokyo"}"#.into(),
                },
            },
            ToolCall {
                id: "tool-2".into(),
                call_type: "function".into(),
                function: ToolCallFunction {
                    name: "weather".into(),
                    arguments: r#"{"city":"Paris"}"#.into(),
                },
            },
        ]);
        let mut first_result = message("tool", ChatContent::Text("sunny".into()));
        first_result.tool_call_id = Some("tool-1".into());
        let mut second_result = message("tool", ChatContent::Text("rainy".into()));
        second_result.tool_call_id = Some("tool-2".into());
        let mut chat_request = request(vec![user, assistant, first_result, second_result]);
        chat_request.tools = Some(vec![ChatTool {
            r#type: "function".into(),
            function: ChatToolFunction {
                name: "weather".into(),
                description: Some("Get weather".into()),
                parameters: Some(serde_json::json!({
                    "type": "object",
                    "properties": {"city": {"type": "string"}}
                })),
            },
        }]);

        let converted = convert_request(&chat_request).unwrap();

        assert!(converted.tools.is_some());
        assert!(matches!(
            converted.messages[1].content(),
            [ContentBlock::ToolUse(_), ContentBlock::ToolUse(_)]
        ));
        assert!(matches!(
            converted.messages[2].content(),
            [ContentBlock::ToolResult(_), ContentBlock::ToolResult(_)]
        ));
    }

    #[test]
    fn rejects_remote_images_and_extended_options() {
        let remote_image = request(vec![message(
            "user",
            ChatContent::Multipart(vec![ContentPart {
                r#type: "image_url".into(),
                text: None,
                image_url: Some(ImageUrl {
                    url: "https://example.com/image.png".into(),
                }),
            }]),
        )]);
        assert!(convert_request(&remote_image)
            .err()
            .unwrap()
            .to_string()
            .contains("remote image URLs"));

        let mut extra = request(vec![message("user", ChatContent::Text("Hi".into()))]);
        extra.extra_body = Some(serde_json::Map::from_iter([(
            "custom".into(),
            serde_json::Value::Bool(true),
        )]));
        assert!(convert_request(&extra)
            .err()
            .unwrap()
            .to_string()
            .contains("extra_body"));
    }

    #[test]
    fn parses_text_and_tool_use_response() {
        let tool = ToolUseBlock::builder()
            .tool_use_id("tool-1")
            .name("weather")
            .input(json_to_document(&serde_json::json!({"city": "Paris"})).unwrap())
            .build()
            .unwrap();
        let (text, tool_calls) = parse_response_content(&[
            ContentBlock::Text("Checking".into()),
            ContentBlock::ToolUse(tool),
        ])
        .unwrap();

        assert_eq!(text, "Checking");
        let tool_call = &tool_calls.unwrap()[0];
        assert_eq!(tool_call.id, "tool-1");
        assert_eq!(tool_call.function.name, "weather");
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&tool_call.function.arguments).unwrap(),
            serde_json::json!({"city": "Paris"})
        );
    }

    #[test]
    fn filters_models_and_only_infers_vision_from_aws_metadata() {
        let lifecycle = FoundationModelLifecycle::builder()
            .status(FoundationModelLifecycleStatus::Active)
            .build()
            .unwrap();
        let summary = FoundationModelSummary::builder()
            .model_arn("arn:aws:bedrock:us-east-1::foundation-model/test")
            .model_id("vendor.chat-model")
            .model_name("Chat Model")
            .provider_name("Vendor")
            .input_modalities(ModelModality::Text)
            .input_modalities(ModelModality::Image)
            .output_modalities(ModelModality::Text)
            .response_streaming_supported(true)
            .model_lifecycle(lifecycle)
            .build()
            .unwrap();

        let model = foundation_model(&summary, &context()).unwrap();
        assert_eq!(model.model_type, ModelType::Chat);
        assert_eq!(
            model.capabilities,
            vec![ModelCapability::TextChat, ModelCapability::Vision]
        );
        assert!(!model
            .capabilities
            .contains(&ModelCapability::FunctionCalling));
    }
}
