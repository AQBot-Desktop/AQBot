use aqbot_core::types::{AppSettings, ModelParamOverrides};

#[derive(Debug, Clone, PartialEq)]
pub struct EffectiveChatModelParams {
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub max_tokens: Option<u32>,
}

pub struct ChatParamInputs<'a> {
    pub conversation_temperature: Option<f32>,
    pub conversation_top_p: Option<f32>,
    pub conversation_max_tokens: Option<u32>,
    pub model_param_overrides: Option<&'a ModelParamOverrides>,
    pub settings: &'a AppSettings,
    pub force_max_tokens: Option<bool>,
    pub max_output_tokens: Option<u32>,
}

pub fn resolve_chat_model_params(input: ChatParamInputs<'_>) -> EffectiveChatModelParams {
    let omit_sampling_params = input
        .model_param_overrides
        .and_then(|params| params.omit_sampling_params)
        .unwrap_or(false);
    let temperature = (!omit_sampling_params)
        .then(|| {
            input
                .conversation_temperature
                .or_else(|| {
                    input
                        .model_param_overrides
                        .and_then(|params| params.temperature)
                })
                .or(input.settings.default_temperature)
                .map(|value| value as f64)
        })
        .flatten();
    let top_p = (!omit_sampling_params)
        .then(|| {
            input
                .conversation_top_p
                .or_else(|| input.model_param_overrides.and_then(|params| params.top_p))
                .or(input.settings.default_top_p)
                .map(|value| value as f64)
        })
        .flatten();
    let configured_max_tokens = match input.conversation_max_tokens {
        Some(max_tokens) => Some(max_tokens),
        None if input.force_max_tokens == Some(true) => input
            .model_param_overrides
            .and_then(|params| params.max_tokens)
            .or(input.settings.default_max_tokens)
            .or(Some(4096)),
        None => input.settings.default_max_tokens,
    };
    let max_tokens = match (configured_max_tokens, input.max_output_tokens) {
        (Some(configured), Some(limit)) if configured > limit => {
            tracing::warn!(
                configured_max_tokens = configured,
                model_max_output_tokens = limit,
                "Clamped chat output tokens to the model metadata limit"
            );
            Some(limit)
        }
        (configured, _) => configured,
    };

    EffectiveChatModelParams {
        temperature,
        top_p,
        max_tokens,
    }
}

pub fn model_extra_body_from_overrides(
    model_param_overrides: Option<&ModelParamOverrides>,
) -> Option<serde_json::Map<String, serde_json::Value>> {
    model_param_overrides.and_then(|params| params.extra_body.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_uses_model_and_settings_without_conversation_overrides() {
        let settings = AppSettings {
            default_temperature: Some(0.2),
            default_max_tokens: Some(128),
            ..AppSettings::default()
        };
        let overrides = ModelParamOverrides {
            temperature: Some(0.5),
            force_max_tokens: Some(true),
            max_tokens: Some(64),
            ..Default::default()
        };
        let params = resolve_chat_model_params(ChatParamInputs {
            conversation_temperature: None,
            conversation_top_p: None,
            conversation_max_tokens: None,
            model_param_overrides: Some(&overrides),
            settings: &settings,
            force_max_tokens: Some(true),
            max_output_tokens: Some(32),
        });
        assert_eq!(params.temperature, Some(0.5));
        assert_eq!(params.max_tokens, Some(32));
    }
}
