use aqbot_core::types::ChatRequest;

#[derive(Debug, Clone, PartialEq)]
pub enum ReasoningStyle {
    None,
    OpenAIReasoningEffort,
    OpenAIResponsesReasoning,
    GeminiThinkingLevel,
    GeminiThinkingBudget,
    AnthropicAdaptive,
    AnthropicBudgetTokens,
    SiliconFlowEnableThinking,
}

#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedReasoning {
    pub style: ReasoningStyle,
    pub level: String,
    pub reasoning_effort: Option<String>,
    pub thinking_level: Option<String>,
    pub budget_tokens: Option<u32>,
    pub enable_thinking: Option<bool>,
    pub suppress_sampling_params: bool,
}

pub fn resolve_reasoning(
    request: &ChatRequest,
    default_style: ReasoningStyle,
) -> Option<ResolvedReasoning> {
    let style = request
        .reasoning_profile
        .as_deref()
        .map(reasoning_style_from_profile)
        .unwrap_or(default_style);
    if style == ReasoningStyle::None {
        return None;
    }

    let level = request
        .thinking_level
        .clone()
        .or_else(|| request.thinking_budget.map(legacy_budget_to_level))?;

    if level == "default" {
        return None;
    }

    let suppress_sampling_params = !matches!(level.as_str(), "off" | "none");
    let budget_tokens = level_to_budget(&level);
    let reasoning_effort = level_to_effort(&level).map(str::to_string);

    match style {
        ReasoningStyle::OpenAIReasoningEffort | ReasoningStyle::OpenAIResponsesReasoning => {
            Some(ResolvedReasoning {
                style,
                level,
                reasoning_effort,
                thinking_level: None,
                budget_tokens: None,
                enable_thinking: None,
                suppress_sampling_params,
            })
        }
        ReasoningStyle::GeminiThinkingLevel => {
            if !matches!(level.as_str(), "minimal" | "low" | "medium" | "high") {
                return None;
            }
            Some(ResolvedReasoning {
                style,
                thinking_level: Some(level.clone()),
                level,
                reasoning_effort: None,
                budget_tokens: None,
                enable_thinking: None,
                suppress_sampling_params: false,
            })
        }
        ReasoningStyle::GeminiThinkingBudget | ReasoningStyle::AnthropicBudgetTokens => {
            Some(ResolvedReasoning {
                style,
                level,
                reasoning_effort: None,
                thinking_level: None,
                budget_tokens,
                enable_thinking: None,
                suppress_sampling_params,
            })
        }
        ReasoningStyle::AnthropicAdaptive => Some(ResolvedReasoning {
            style,
            level,
            reasoning_effort,
            thinking_level: None,
            budget_tokens: None,
            enable_thinking: None,
            suppress_sampling_params,
        }),
        ReasoningStyle::SiliconFlowEnableThinking => Some(ResolvedReasoning {
            style,
            level,
            reasoning_effort: None,
            thinking_level: None,
            budget_tokens,
            enable_thinking: Some(suppress_sampling_params),
            suppress_sampling_params,
        }),
        ReasoningStyle::None => None,
    }
}

fn reasoning_style_from_profile(profile: &str) -> ReasoningStyle {
    match profile {
        "openai_reasoning_effort" => ReasoningStyle::OpenAIReasoningEffort,
        "openai_responses_reasoning" => ReasoningStyle::OpenAIResponsesReasoning,
        "gemini_thinking_level" => ReasoningStyle::GeminiThinkingLevel,
        "gemini_thinking_budget" => ReasoningStyle::GeminiThinkingBudget,
        "anthropic_adaptive" => ReasoningStyle::AnthropicAdaptive,
        "anthropic_budget_tokens" => ReasoningStyle::AnthropicBudgetTokens,
        "siliconflow_enable_thinking" => ReasoningStyle::SiliconFlowEnableThinking,
        "none" => ReasoningStyle::None,
        // Backward-compatible aliases from the old model settings UI.
        "reasoning_effort" => ReasoningStyle::OpenAIReasoningEffort,
        "enable_thinking" => ReasoningStyle::SiliconFlowEnableThinking,
        _ => ReasoningStyle::None,
    }
}

fn legacy_budget_to_level(budget: u32) -> String {
    match budget {
        0 => "none",
        1..=2048 => "low",
        2049..=6144 => "medium",
        6145..=12288 => "high",
        _ => "xhigh",
    }
    .to_string()
}

fn level_to_effort(level: &str) -> Option<&'static str> {
    match level {
        "off" => Some("none"),
        "none" => Some("none"),
        "minimal" => Some("minimal"),
        "low" => Some("low"),
        "medium" => Some("medium"),
        "high" => Some("high"),
        "xhigh" => Some("xhigh"),
        "max" => Some("max"),
        _ => None,
    }
}

fn level_to_budget(level: &str) -> Option<u32> {
    match level {
        "off" | "none" => Some(0),
        "low" => Some(1024),
        "medium" => Some(4096),
        "high" => Some(8192),
        "xhigh" => Some(16384),
        "max" => Some(32768),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use aqbot_core::types::{ChatContent, ChatMessage};

    fn request(thinking_level: Option<&str>, thinking_budget: Option<u32>) -> ChatRequest {
        ChatRequest {
            model: "gemini-3-flash-preview".to_string(),
            messages: vec![ChatMessage {
                role: "user".to_string(),
                content: ChatContent::Text("hi".to_string()),
                reasoning_content: None,
                tool_calls: None,
                tool_call_id: None,
            }],
            stream: false,
            temperature: None,
            top_p: None,
            max_tokens: None,
            tools: None,
            thinking_budget,
            thinking_level: thinking_level.map(str::to_string),
            reasoning_profile: None,
            use_max_completion_tokens: None,
            thinking_param_style: None,
        }
    }

    #[test]
    fn gemini_thinking_level_rejects_invalid_off_level() {
        let resolved = resolve_reasoning(
            &request(Some("off"), None),
            ReasoningStyle::GeminiThinkingLevel,
        );

        assert!(resolved.is_none());
    }

    #[test]
    fn openai_treats_off_alias_as_none_effort() {
        let resolved = resolve_reasoning(
            &request(Some("off"), None),
            ReasoningStyle::OpenAIReasoningEffort,
        )
        .expect("reasoning config");

        assert_eq!(resolved.reasoning_effort.as_deref(), Some("none"));
    }
}
