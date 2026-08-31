use std::sync::atomic::Ordering;
use std::time::Instant;

use aqbot_core::{
    crypto::decrypt_key,
    repo::{conversation as conversation_repo, provider, settings as settings_repo},
    types::{
        AppSettings, ChatRequest, ModelParamOverrides, ModelType, ProviderProxyConfig,
        ProviderType, SelectionToolbarAiConfig,
    },
};
use aqbot_providers::{
    registry::ProviderRegistry, resolve_base_url_for_type, ProviderRequestContext,
};
use futures::StreamExt;
use serde::Deserialize;
use tauri::{AppHandle, Emitter};

use crate::AppState;

use super::{SurfaceSize, ToolRunEvent, SELECTION_TOOLBAR_WINDOW_LABEL};

/// Per-run overrides supplied by the toolbar UI (currently the translate
/// panel's language pickers). All fields optional so older frontends and
/// non-translate tools can omit them.
#[derive(Debug, Clone, Default, Deserialize)]
pub struct ToolRunOptions {
    /// Language of the selected text; `None`/empty means auto-detect.
    #[serde(default)]
    pub source_language: Option<String>,
    /// Overrides the configured translate target language for this run.
    #[serde(default)]
    pub target_language: Option<String>,
}

#[derive(Debug, PartialEq)]
struct EffectiveParams {
    temperature: Option<f64>,
    top_p: Option<f64>,
    max_tokens: Option<u32>,
    use_max_completion_tokens: Option<bool>,
    thinking_param_style: Option<String>,
    reasoning_profile: Option<String>,
    thinking_level: Option<String>,
    extra_body: Option<serde_json::Map<String, serde_json::Value>>,
}

pub async fn execute_tool(
    app: &AppHandle,
    state: &AppState,
    selection_id: &str,
    tool_id: &str,
    options: ToolRunOptions,
) -> Result<String, String> {
    let settings = settings_repo::get_settings(&state.sea_db)
        .await
        .map_err(|error| error.to_string())?;
    settings.selection_toolbar.validate()?;
    if !settings.selection_toolbar.enabled {
        return Err("Selection toolbar is disabled".into());
    }
    let ai = settings
        .selection_toolbar
        .tools
        .iter()
        .find(|tool| tool.id() == tool_id)
        .filter(|tool| tool.enabled())
        .and_then(|tool| tool.ai())
        .cloned()
        .ok_or_else(|| "The requested selection toolbar AI tool is unavailable".to_string())?;
    let selection = state
        .selection_toolbar
        .selection_text(selection_id)
        .await
        .ok_or_else(|| "The selected text is no longer active".to_string())?;
    let prompt = render_prompt(
        &ai.prompt,
        &selection,
        &resolve_languages(&options, &settings),
    );
    let (configured_provider_id, model_id) = match resolve_model_target(&ai, &settings)? {
        Some(target) => target,
        // No tool-level or global default model: inherit the model of the most
        // recently active conversation instead of failing outright.
        None => conversation_repo::most_recent_conversation_model(&state.sea_db)
            .await
            .map_err(|error| error.to_string())?
            .ok_or_else(|| {
                "No default Chat model is configured and there is no recent conversation to inherit one from".to_string()
            })?,
    };
    let provider_id = provider::resolve_provider_id(&state.sea_db, &configured_provider_id)
        .await
        .map_err(|error| error.to_string())?;
    let provider = provider::get_provider(&state.sea_db, &provider_id)
        .await
        .map_err(|error| error.to_string())?;
    if !provider.enabled {
        return Err(format!("Provider {} is disabled", provider.name));
    }
    let model = provider::get_model(&state.sea_db, &provider_id, &model_id)
        .await
        .map_err(|error| error.to_string())?;
    if !model.enabled {
        return Err(format!("Model {} is disabled", model.name));
    }
    if model.model_type != ModelType::Chat {
        return Err(format!("Model {} does not support Chat", model.name));
    }
    let params = resolve_effective_params(
        &ai,
        &settings,
        model.param_overrides.as_ref(),
        model.max_output_tokens,
    );
    let request = ChatRequest {
        model: model_id,
        messages: Vec::new(),
        stream: true,
        temperature: params.temperature,
        top_p: params.top_p,
        max_tokens: params.max_tokens,
        tools: None,
        thinking_budget: None,
        thinking_level: params.thinking_level,
        reasoning_profile: params.reasoning_profile,
        use_max_completion_tokens: params.use_max_completion_tokens,
        thinking_param_style: params.thinking_param_style,
        extra_body: params.extra_body,
    };
    let prepared = state
        .selection_toolbar
        .begin_new_tool_run(
            selection_id,
            tool_id,
            super::ToolExecutionConfig {
                provider_id,
                request,
            },
            prompt,
        )
        .await?;
    launch_run(app, state, prepared).await
}

pub async fn follow_up(
    app: &AppHandle,
    state: &AppState,
    selection_id: &str,
    text: &str,
) -> Result<String, String> {
    let text = text.trim();
    if text.is_empty() {
        return Err("Follow-up text cannot be empty".into());
    }
    let prepared = state
        .selection_toolbar
        .begin_follow_up_run(selection_id, text.to_string())
        .await?;
    launch_run(app, state, prepared).await
}

pub async fn regenerate(
    app: &AppHandle,
    state: &AppState,
    selection_id: &str,
    request_id: &str,
) -> Result<String, String> {
    let prepared = state
        .selection_toolbar
        .begin_regenerate_run(selection_id, request_id)
        .await?;
    launch_run(app, state, prepared).await
}

async fn launch_run(
    app: &AppHandle,
    state: &AppState,
    prepared: super::PreparedToolRun,
) -> Result<String, String> {
    let request_id = prepared.request_id.clone();
    if let Err(error) = state
        .selection_toolbar
        .set_surface(app, SurfaceSize::Result, None)
        .await
    {
        let _ = state
            .selection_toolbar
            .fail_run(&request_id, error.clone())
            .await;
        return Err(error);
    }
    emit_run(
        app,
        ToolRunEvent::Started {
            request_id: request_id.clone(),
            selection_id: prepared.selection_id.clone(),
            tool_id: prepared.tool_id.clone(),
            mode: prepared.mode,
            user_input: prepared.user_input.clone(),
        },
    );
    let selection_id = prepared.selection_id.clone();
    tracing::info!(
        %selection_id,
        request_id,
        mode = ?prepared.mode,
        "Selection toolbar generation started"
    );

    let (context, registry_key) = match resolve_run_transport(state, &prepared.config).await {
        Ok(transport) => transport,
        Err(error) => {
            publish_error(
                app,
                &state.selection_toolbar,
                &request_id,
                &selection_id,
                error,
            )
            .await;
            return Ok(request_id);
        }
    };

    let app = app.clone();
    let runtime = state.selection_toolbar.clone();
    let request_id_for_task = request_id.clone();
    let request = prepared.config.request;
    let cancel = prepared.cancel;
    tauri::async_runtime::spawn(async move {
        let registry = ProviderRegistry::create_default();
        let Some(adapter) = registry.get(&registry_key) else {
            publish_error(
                &app,
                &runtime,
                &request_id_for_task,
                &selection_id,
                format!("Provider type {registry_key} does not support Chat"),
            )
            .await;
            return;
        };
        // Thinking deltas are merged into the content stream as
        // `<think data-aqbot="1">` blocks — the same wire format the chat
        // pipeline produces — so the toolbar renders reasoning 1:1 with chat.
        let mut think = ThinkMerge::default();
        let mut stream = adapter.chat_stream(&context, request);
        while let Some(chunk) = stream.next().await {
            if cancel.load(Ordering::Relaxed) {
                finalize_stopped(
                    &app,
                    &runtime,
                    &request_id_for_task,
                    &selection_id,
                    &mut think,
                )
                .await;
                return;
            }
            match chunk {
                Ok(chunk) => {
                    let mut delta = String::new();
                    if let Some(thinking) = chunk.thinking.as_deref().filter(|t| !t.is_empty()) {
                        think.open_into(&mut delta);
                        delta.push_str(thinking);
                    }
                    if let Some(content) = chunk.content.as_deref().filter(|c| !c.is_empty()) {
                        think.close_into(&mut delta);
                        delta.push_str(content);
                    }
                    let done = chunk.done || chunk.is_final == Some(true);
                    if done {
                        think.close_into(&mut delta);
                    }
                    if !delta.is_empty() {
                        think.emitted = true;
                        if !runtime.append_delta(&request_id_for_task, &delta).await {
                            return;
                        }
                        emit_run(
                            &app,
                            ToolRunEvent::Delta {
                                request_id: request_id_for_task.clone(),
                                selection_id: selection_id.clone(),
                                delta,
                            },
                        );
                    }
                    if done {
                        complete_run(&app, &runtime, &request_id_for_task, &selection_id, &think)
                            .await;
                        return;
                    }
                }
                Err(error) => {
                    publish_error(
                        &app,
                        &runtime,
                        &request_id_for_task,
                        &selection_id,
                        error.to_string(),
                    )
                    .await;
                    return;
                }
            }
        }
        if cancel.load(Ordering::Relaxed) {
            finalize_stopped(
                &app,
                &runtime,
                &request_id_for_task,
                &selection_id,
                &mut think,
            )
            .await;
        } else {
            // Stream ended without a done marker: close any dangling think block.
            let mut delta = String::new();
            think.close_into(&mut delta);
            if !delta.is_empty() && runtime.append_delta(&request_id_for_task, &delta).await {
                emit_run(
                    &app,
                    ToolRunEvent::Delta {
                        request_id: request_id_for_task.clone(),
                        selection_id: selection_id.clone(),
                        delta,
                    },
                );
            }
            complete_run(&app, &runtime, &request_id_for_task, &selection_id, &think).await;
        }
    });
    Ok(request_id)
}

async fn resolve_run_transport(
    state: &AppState,
    config: &super::ToolExecutionConfig,
) -> Result<(ProviderRequestContext, String), String> {
    let settings = settings_repo::get_settings(&state.sea_db)
        .await
        .map_err(|error| error.to_string())?;
    let provider = provider::get_provider(&state.sea_db, &config.provider_id)
        .await
        .map_err(|error| error.to_string())?;
    if !provider.enabled {
        return Err(format!("Provider {} is disabled", provider.name));
    }
    let model = provider::get_model(&state.sea_db, &config.provider_id, &config.request.model)
        .await
        .map_err(|error| error.to_string())?;
    if !model.enabled {
        return Err(format!("Model {} is disabled", model.name));
    }
    if model.model_type != ModelType::Chat {
        return Err(format!("Model {} does not support Chat", model.name));
    }
    let registry_key = provider_registry_key(&provider.provider_type).to_string();
    if ProviderRegistry::create_default()
        .get(&registry_key)
        .is_none()
    {
        return Err(format!(
            "Provider type {registry_key} does not support Chat"
        ));
    }
    let key = provider::get_active_key(&state.sea_db, &config.provider_id)
        .await
        .map_err(|error| error.to_string())?;
    let api_key =
        decrypt_key(&key.key_encrypted, &state.master_key).map_err(|error| error.to_string())?;
    let custom_headers = provider
        .custom_headers
        .as_deref()
        .map(serde_json::from_str)
        .transpose()
        .map_err(|error| format!("Invalid provider custom headers: {error}"))?;
    let context = ProviderRequestContext {
        api_key,
        key_id: key.id,
        provider_id: provider.id,
        base_url: Some(resolve_base_url_for_type(
            &provider.api_host,
            &provider.provider_type,
        )),
        api_path: provider.api_path,
        aws_region: provider.aws_region,
        proxy_config: ProviderProxyConfig::resolve(&provider.proxy_config, &settings),
        custom_headers,
    };
    Ok((context, registry_key))
}

/// Merges provider thinking deltas into the content stream as
/// `<think data-aqbot="1">` blocks, mirroring the chat pipeline
/// (`commands::conversations::consume_stream`).
#[derive(Default)]
struct ThinkMerge {
    in_block: bool,
    block_started: Option<Instant>,
    durations: Vec<u64>,
    /// Whether any delta text was emitted yet (controls the leading blank line).
    emitted: bool,
}

impl ThinkMerge {
    fn open_into(&mut self, delta: &mut String) {
        if self.in_block {
            return;
        }
        // Blank line before <think> so the markdown parser sees a new block.
        if self.emitted {
            delta.push_str("\n\n");
        }
        delta.push_str("<think data-aqbot=\"1\">\n");
        self.in_block = true;
        self.block_started = Some(Instant::now());
    }

    fn close_into(&mut self, delta: &mut String) {
        if !self.in_block {
            return;
        }
        let total_ms = self
            .block_started
            .take()
            .map(|started| started.elapsed().as_millis() as u64)
            .unwrap_or(0);
        self.durations.push(total_ms);
        delta.push_str("\n</think>\n\n");
        self.in_block = false;
    }
}

/// Rewrites the stored output with duration-stamped think tags and returns it
/// for the terminal event, so the frontend shows the same collapsed
/// "thought for N s" header as chat.
async fn finalized_output(
    runtime: &super::SelectionToolbarRuntime,
    request_id: &str,
    think: &ThinkMerge,
) -> Option<String> {
    let output = runtime.run_output(request_id).await?;
    let fixed = crate::commands::conversations::fixup_think_tags(&output, &think.durations);
    if fixed != output {
        runtime.replace_output(request_id, fixed.clone()).await;
    }
    Some(fixed)
}

async fn finalize_stopped(
    app: &AppHandle,
    runtime: &super::SelectionToolbarRuntime,
    request_id: &str,
    selection_id: &str,
    think: &mut ThinkMerge,
) {
    tracing::info!(request_id, "Selection toolbar generation stopped");
    let mut closing = String::new();
    think.close_into(&mut closing);
    let output = match runtime.run_output(request_id).await {
        Some(output) => output + &closing,
        None => return,
    };
    let fixed = crate::commands::conversations::fixup_think_tags(&output, &think.durations);
    runtime.replace_output(request_id, fixed.clone()).await;
    emit_run(
        app,
        ToolRunEvent::Stopped {
            request_id: request_id.into(),
            selection_id: selection_id.into(),
            output: Some(fixed),
        },
    );
}

#[derive(Debug, PartialEq)]
struct PromptLanguages {
    source: String,
    target: String,
    app: String,
}

/// Effective languages for the `{source_language}` / `{target_language}`
/// placeholders: run override → configured translate target → app UI language.
fn resolve_languages(options: &ToolRunOptions, settings: &AppSettings) -> PromptLanguages {
    let non_blank = |value: &Option<String>| {
        value
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
    };
    let source = non_blank(&options.source_language).filter(|code| code != "auto");
    let target = non_blank(&options.target_language)
        .or_else(|| non_blank(&settings.selection_toolbar.translate_target_language))
        .unwrap_or_else(|| settings.language.clone());
    PromptLanguages {
        source: source
            .map(|code| super::languages::prompt_language_name(&code))
            .unwrap_or_else(|| "the automatically detected source language".to_string()),
        target: super::languages::prompt_language_name(&target),
        app: super::languages::prompt_language_name(&settings.language),
    }
}

fn render_prompt(template: &str, selection: &str, languages: &PromptLanguages) -> String {
    // Languages first, selection last: the selected text must never be
    // re-scanned for placeholders.
    template
        .replace("{source_language}", &languages.source)
        .replace("{target_language}", &languages.target)
        .replace("{app_language}", &languages.app)
        .replace("{selection}", selection)
}

/// `Ok(None)` means "nothing configured" — the caller falls back to the most
/// recent conversation's model.
fn resolve_model_target(
    ai: &SelectionToolbarAiConfig,
    settings: &AppSettings,
) -> Result<Option<(String, String)>, String> {
    match (&ai.provider_id, &ai.model_id) {
        (Some(provider_id), Some(model_id)) => Ok(Some((provider_id.clone(), model_id.clone()))),
        (None, None) => Ok(
            match (
                settings.default_provider_id.as_ref(),
                settings.default_model_id.as_ref(),
            ) {
                (Some(provider_id), Some(model_id)) => {
                    Some((provider_id.clone(), model_id.clone()))
                }
                _ => None,
            },
        ),
        _ => Err("Selection toolbar provider and model must be configured together".into()),
    }
}

fn resolve_effective_params(
    ai: &SelectionToolbarAiConfig,
    settings: &AppSettings,
    overrides: Option<&ModelParamOverrides>,
    max_output_tokens: Option<u32>,
) -> EffectiveParams {
    let omit_sampling = overrides
        .and_then(|value| value.omit_sampling_params)
        .unwrap_or(false);
    let temperature = (!omit_sampling)
        .then(|| {
            ai.temperature
                .or_else(|| overrides.and_then(|value| value.temperature))
                .or(settings.default_temperature)
                .map(f64::from)
        })
        .flatten();
    let top_p = (!omit_sampling)
        .then(|| {
            ai.top_p
                .or_else(|| overrides.and_then(|value| value.top_p))
                .or(settings.default_top_p)
                .map(f64::from)
        })
        .flatten();
    let force_max_tokens = overrides
        .and_then(|value| value.force_max_tokens)
        .unwrap_or(false);
    let configured_max_tokens = ai.max_tokens.or_else(|| {
        if force_max_tokens {
            overrides
                .and_then(|value| value.max_tokens)
                .or(settings.default_max_tokens)
                .or(Some(4096))
        } else {
            settings.default_max_tokens
        }
    });
    let max_tokens = match (configured_max_tokens, max_output_tokens) {
        (Some(configured), Some(limit)) => Some(configured.min(limit)),
        (configured, _) => configured,
    };

    EffectiveParams {
        temperature,
        top_p,
        max_tokens,
        use_max_completion_tokens: overrides.and_then(|value| value.use_max_completion_tokens),
        thinking_param_style: overrides.and_then(|value| value.thinking_param_style.clone()),
        reasoning_profile: overrides.and_then(|value| value.reasoning_profile.clone()),
        thinking_level: overrides.and_then(|value| value.reasoning_default.clone()),
        extra_body: overrides.and_then(|value| value.extra_body.clone()),
    }
}

fn provider_registry_key(provider_type: &ProviderType) -> &'static str {
    match provider_type {
        ProviderType::OpenAI => "openai",
        ProviderType::OpenAIResponses => "openai_responses",
        ProviderType::DeepSeek => "deepseek",
        ProviderType::XAI => "xai",
        ProviderType::GLM => "glm",
        ProviderType::SiliconFlow => "siliconflow",
        ProviderType::Anthropic => "anthropic",
        ProviderType::Gemini => "gemini",
        ProviderType::Jina => "jina",
        ProviderType::Cohere => "cohere",
        ProviderType::Voyage => "voyage",
        ProviderType::Bedrock => "bedrock",
        ProviderType::Custom => "custom",
    }
}

fn emit_run(app: &AppHandle, event: ToolRunEvent) {
    let _ = app.emit_to(
        SELECTION_TOOLBAR_WINDOW_LABEL,
        "selection-toolbar://run",
        event,
    );
}

async fn complete_run(
    app: &AppHandle,
    runtime: &super::SelectionToolbarRuntime,
    request_id: &str,
    selection_id: &str,
    think: &ThinkMerge,
) {
    if runtime.complete_run(request_id).await {
        runtime.unlock_interaction();
        let output = finalized_output(runtime, request_id, think).await;
        emit_run(
            app,
            ToolRunEvent::Completed {
                request_id: request_id.into(),
                selection_id: selection_id.into(),
                output,
            },
        );
        tracing::info!(request_id, "Selection toolbar generation completed");
    }
}

async fn publish_error(
    app: &AppHandle,
    runtime: &super::SelectionToolbarRuntime,
    request_id: &str,
    selection_id: &str,
    error: String,
) {
    if runtime.fail_run(request_id, error.clone()).await {
        runtime.unlock_interaction();
        emit_run(
            app,
            ToolRunEvent::Error {
                request_id: request_id.into(),
                selection_id: selection_id.into(),
                error,
            },
        );
        tracing::warn!(request_id, "Selection toolbar generation failed");
    }
}

#[cfg(test)]
mod tests {
    use aqbot_core::types::{AppSettings, ModelParamOverrides, SelectionToolbarAiConfig};

    use super::{
        render_prompt, resolve_effective_params, resolve_languages, resolve_model_target,
        PromptLanguages, ThinkMerge, ToolRunOptions,
    };

    #[test]
    fn thinking_deltas_are_merged_into_chat_style_think_blocks() {
        let mut think = ThinkMerge::default();
        let mut delta = String::new();

        think.open_into(&mut delta);
        delta.push_str("pondering");
        assert_eq!(delta, "<think data-aqbot=\"1\">\npondering");
        think.emitted = true;

        let mut second = String::new();
        think.open_into(&mut second);
        assert!(second.is_empty(), "an open block must not reopen");

        think.close_into(&mut second);
        second.push_str("answer");
        assert_eq!(second, "\n</think>\n\nanswer");
        assert_eq!(think.durations.len(), 1);

        let mut third = String::new();
        think.close_into(&mut third);
        assert!(third.is_empty(), "closing twice must be a no-op");
    }

    #[test]
    fn think_blocks_after_content_start_on_a_fresh_markdown_block() {
        let mut think = ThinkMerge {
            emitted: true,
            ..Default::default()
        };
        let mut delta = String::new();

        think.open_into(&mut delta);

        assert_eq!(delta, "\n\n<think data-aqbot=\"1\">\n");
    }

    #[test]
    fn finalized_think_output_gets_duration_stamps() {
        let mut think = ThinkMerge::default();
        let mut delta = String::new();
        think.open_into(&mut delta);
        delta.push_str("reasoning");
        think.close_into(&mut delta);

        let fixed = crate::commands::conversations::fixup_think_tags(&delta, &think.durations);

        assert!(fixed.starts_with("<think totalMs=\""));
        assert!(!fixed.contains("data-aqbot"));
    }

    fn ai_config() -> SelectionToolbarAiConfig {
        SelectionToolbarAiConfig {
            prompt: "Before {selection}; after {selection}".into(),
            provider_id: None,
            model_id: None,
            temperature: Some(0.2),
            top_p: Some(0.7),
            max_tokens: Some(9000),
        }
    }

    #[test]
    fn prompt_replaces_every_selection_placeholder() {
        let languages = PromptLanguages {
            source: "English".into(),
            target: "Simplified Chinese".into(),
            app: "Simplified Chinese".into(),
        };
        assert_eq!(
            render_prompt(
                "Before {selection}; after {selection}",
                "private",
                &languages
            ),
            "Before private; after private"
        );
    }

    #[test]
    fn prompt_renders_languages_without_rescanning_the_selection() {
        let languages = PromptLanguages {
            source: "English".into(),
            target: "Japanese".into(),
            app: "Simplified Chinese".into(),
        };
        assert_eq!(
            render_prompt(
                "From {source_language} to {target_language}; explain in {app_language}:\n{selection}",
                "keep {target_language} and {app_language} literal",
                &languages,
            ),
            "From English to Japanese; explain in Simplified Chinese:\nkeep {target_language} and {app_language} literal"
        );
    }

    #[test]
    fn languages_resolve_override_then_setting_then_app_language() {
        let mut settings = AppSettings {
            language: "zh-CN".into(),
            ..Default::default()
        };

        let auto = resolve_languages(&ToolRunOptions::default(), &settings);
        assert_eq!(
            auto,
            PromptLanguages {
                source: "the automatically detected source language".into(),
                target: "Simplified Chinese".into(),
                app: "Simplified Chinese".into(),
            }
        );

        settings.selection_toolbar.translate_target_language = Some("ja".into());
        let configured = resolve_languages(&ToolRunOptions::default(), &settings);
        assert_eq!(configured.target, "Japanese");

        let overridden = resolve_languages(
            &ToolRunOptions {
                source_language: Some("fr".into()),
                target_language: Some("ko".into()),
            },
            &settings,
        );
        assert_eq!(overridden.source, "French");
        assert_eq!(overridden.target, "Korean");
        assert_eq!(overridden.app, "Simplified Chinese");

        let auto_source = resolve_languages(
            &ToolRunOptions {
                source_language: Some("auto".into()),
                target_language: None,
            },
            &settings,
        );
        assert_eq!(
            auto_source.source,
            "the automatically detected source language"
        );
    }

    #[test]
    fn model_target_inherits_only_when_tool_has_no_explicit_pair() {
        let mut settings = AppSettings {
            default_provider_id: Some("provider-default".into()),
            default_model_id: Some("model-default".into()),
            ..Default::default()
        };
        let mut ai = ai_config();

        assert_eq!(
            resolve_model_target(&ai, &settings).unwrap(),
            Some(("provider-default".into(), "model-default".into()))
        );

        ai.provider_id = Some("provider-explicit".into());
        ai.model_id = Some("model-explicit".into());
        settings.default_provider_id = None;
        settings.default_model_id = None;
        assert_eq!(
            resolve_model_target(&ai, &settings).unwrap(),
            Some(("provider-explicit".into(), "model-explicit".into()))
        );

        ai.provider_id = None;
        ai.model_id = None;
        assert_eq!(
            resolve_model_target(&ai, &settings).unwrap(),
            None,
            "missing defaults defer to the recent-conversation fallback"
        );

        ai.provider_id = Some("provider-only".into());
        assert!(resolve_model_target(&ai, &settings).is_err());
    }

    #[test]
    fn effective_params_respect_model_contract_and_output_limit() {
        let settings = AppSettings {
            default_temperature: Some(1.0),
            default_top_p: Some(0.9),
            default_max_tokens: Some(4096),
            ..Default::default()
        };
        let overrides = ModelParamOverrides {
            omit_sampling_params: Some(true),
            force_max_tokens: Some(true),
            use_max_completion_tokens: Some(true),
            ..Default::default()
        };

        let params =
            resolve_effective_params(&ai_config(), &settings, Some(&overrides), Some(2048));
        assert_eq!(params.temperature, None);
        assert_eq!(params.top_p, None);
        assert_eq!(params.max_tokens, Some(2048));
        assert_eq!(params.use_max_completion_tokens, Some(true));
    }
}
