// Automatic conversation title generation.

const DEFAULT_TITLE_PROMPT: &str = "You are a title generator. Based on the conversation below, generate a concise and descriptive title (maximum 30 characters). Reply with the title only, no quotes or extra text.";
const AUTO_TITLE_CHAR_LIMIT: usize = 30;
const DEFAULT_TITLE_SUMMARY_MAX_TOKENS: u32 = 1024;
const RETRY_TITLE_SUMMARY_MAX_TOKENS: u32 = 4096;

fn title_summary_max_tokens(settings: &AppSettings) -> u32 {
    settings
        .title_summary_max_tokens
        .unwrap_or(DEFAULT_TITLE_SUMMARY_MAX_TOKENS)
}

fn clean_generated_title(content: &str) -> String {
    normalize_auto_conversation_title(content)
}

fn validated_generated_title(content: &str) -> Result<String, String> {
    let title = clean_generated_title(content);
    if aqbot_core::inline_media::contains_inline_image_data(&title) {
        return Err("AI-generated title contains inline image data".to_string());
    }
    Ok(title)
}

pub(crate) fn normalize_auto_conversation_title(content: &str) -> String {
    let cleaned = content
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .trim()
        .trim_matches('"')
        .trim_matches('\'')
        .trim_matches('“')
        .trim_matches('”')
        .trim_matches('「')
        .trim_matches('」')
        .trim_matches('《')
        .trim_matches('》')
        .trim()
        .to_string();
    truncate_auto_title(&cleaned)
}

fn truncate_auto_title(text: &str) -> String {
    let mut chars = text.chars();
    let truncated = chars
        .by_ref()
        .take(AUTO_TITLE_CHAR_LIMIT)
        .collect::<String>();
    if chars.next().is_some() {
        format!("{truncated}...")
    } else {
        truncated
    }
}

fn should_auto_generate_title(is_first_message: bool, conversation_mode: &str) -> bool {
    is_first_message && conversation_mode != "role"
}

fn truncate_chars(text: &str, limit: usize) -> String {
    text.chars().take(limit).collect()
}

fn chat_content_text(content: &ChatContent) -> String {
    match content {
        ChatContent::Text(text) => text.clone(),
        ChatContent::Multipart(parts) => parts
            .iter()
            .filter_map(|part| part.text.as_deref())
            .collect::<Vec<_>>()
            .join(" "),
    }
}

async fn call_title_chat(
    adapter: &dyn ProviderAdapter,
    ctx: &ProviderRequestContext,
    request: ChatRequest,
) -> Result<ChatResponse, String> {
    adapter.chat(ctx, request).await.map_err(|e| {
        let err = format!("Chat API error: {}", e);
        tracing::error!("[title-gen] {}", err);
        err
    })
}

fn configured_title_summary_target(settings: &AppSettings) -> Option<(&str, &str)> {
    settings
        .title_summary_provider_id
        .as_deref()
        .zip(settings.title_summary_model_id.as_deref())
}

/// Generate an AI-powered conversation title using the configured title summary model.
/// Returns Err with the actual error message if generation fails.
pub async fn generate_ai_title(
    db: &sea_orm::DatabaseConnection,
    user_content: &str,
    assistant_content: &str,
    fallback_provider: &ProviderConfig,
    fallback_ctx: &ProviderRequestContext,
    fallback_model_id: &str,
    settings: &AppSettings,
    master_key: &[u8; 32],
) -> Result<String, String> {
    // Helper: look up use_max_completion_tokens from model param_overrides
    let lookup_umc = |provider_id: &str, model_id: &str, db: &sea_orm::DatabaseConnection| {
        let pid = provider_id.to_string();
        let mid = model_id.to_string();
        let db = db.clone();
        async move {
            aqbot_core::repo::provider::get_model(&db, &pid, &mid)
                .await
                .ok()
                .and_then(|m| m.param_overrides)
                .and_then(|po| po.use_max_completion_tokens)
        }
    };

    // Resolve title summary provider/model: settings override → fallback to conversation model
    if let Some((pid, mid)) = configured_title_summary_target(settings) {
        // Try to use the configured title summary provider
        let provider = match aqbot_core::repo::provider::get_provider(db, pid).await {
            Ok(p) => p,
            Err(e) => {
                tracing::warn!("Title summary provider not found, falling back: {}", e);
                let umc = lookup_umc(&fallback_ctx.provider_id, fallback_model_id, db).await;
                return generate_ai_title_with(
                    fallback_provider,
                    fallback_ctx,
                    fallback_model_id,
                    user_content,
                    assistant_content,
                    settings,
                    umc,
                )
                .await;
            }
        };
        let key_row = match aqbot_core::repo::provider::get_active_key(db, pid).await {
            Ok(k) => k,
            Err(e) => {
                tracing::warn!(
                    "Title summary provider has no active key, falling back: {}",
                    e
                );
                let umc = lookup_umc(&fallback_ctx.provider_id, fallback_model_id, db).await;
                return generate_ai_title_with(
                    fallback_provider,
                    fallback_ctx,
                    fallback_model_id,
                    user_content,
                    assistant_content,
                    settings,
                    umc,
                )
                .await;
            }
        };
        let dk = match aqbot_core::crypto::decrypt_key(&key_row.key_encrypted, master_key) {
            Ok(dk) => dk,
            Err(e) => {
                tracing::warn!("Title summary key decrypt failed, falling back: {}", e);
                let umc = lookup_umc(&fallback_ctx.provider_id, fallback_model_id, db).await;
                return generate_ai_title_with(
                    fallback_provider,
                    fallback_ctx,
                    fallback_model_id,
                    user_content,
                    assistant_content,
                    settings,
                    umc,
                )
                .await;
            }
        };
        let proxy = ProviderProxyConfig::resolve(&provider.proxy_config, settings);
        let ctx = ProviderRequestContext {
            api_key: dk,
            key_id: key_row.id.clone(),
            provider_id: provider.id.clone(),
            base_url: Some(resolve_base_url_for_type(
                &provider.api_host,
                &provider.provider_type,
            )),
            api_path: provider.api_path.clone(),
            aws_region: provider.aws_region.clone(),
            proxy_config: proxy,
            custom_headers: provider
                .custom_headers
                .as_ref()
                .and_then(|s| serde_json::from_str(s).ok()),
        };
        let umc = lookup_umc(pid, mid, db).await;
        generate_ai_title_with(
            &provider,
            &ctx,
            mid,
            user_content,
            assistant_content,
            settings,
            umc,
        )
        .await
    } else {
        // No title summary provider configured, use conversation model
        let umc = lookup_umc(&fallback_ctx.provider_id, fallback_model_id, db).await;
        generate_ai_title_with(
            fallback_provider,
            fallback_ctx,
            fallback_model_id,
            user_content,
            assistant_content,
            settings,
            umc,
        )
        .await
    }
}

#[cfg(test)]
mod title_target_tests {
    use super::*;

    #[test]
    fn global_title_model_requires_a_complete_provider_and_model_pair() {
        let mut settings = AppSettings::default();
        assert_eq!(configured_title_summary_target(&settings), None);

        settings.title_summary_provider_id = Some("title-provider".to_string());
        assert_eq!(configured_title_summary_target(&settings), None);

        settings.title_summary_model_id = Some("title-model".to_string());
        assert_eq!(
            configured_title_summary_target(&settings),
            Some(("title-provider", "title-model"))
        );
    }
}

async fn generate_ai_title_with(
    provider: &ProviderConfig,
    ctx: &ProviderRequestContext,
    model_id: &str,
    user_content: &str,
    assistant_content: &str,
    settings: &AppSettings,
    use_max_completion_tokens: Option<bool>,
) -> Result<String, String> {
    let prompt = settings
        .title_summary_prompt
        .as_deref()
        .unwrap_or(DEFAULT_TITLE_PROMPT);

    // Build conversation context for title generation
    let mut conversation_text = format!("User: {}", user_content);
    if !assistant_content.is_empty() {
        // Include a truncated assistant response for better context
        let assistant_preview: String = assistant_content.chars().take(500).collect();
        conversation_text.push_str(&format!("\n\nAssistant: {}", assistant_preview));
    }

    let messages = vec![
        ChatMessage {
            role: "system".to_string(),
            content: ChatContent::Text(prompt.to_string()),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        },
        ChatMessage {
            role: "user".to_string(),
            content: ChatContent::Text(conversation_text),
            reasoning_content: None,
            tool_calls: None,
            tool_call_id: None,
        },
    ];

    let mut request = ChatRequest {
        model: model_id.to_string(),
        messages,
        stream: false,
        temperature: settings
            .title_summary_temperature
            .map(|v| v as f64)
            .or(Some(0.3)),
        top_p: settings.title_summary_top_p.map(|v| v as f64),
        max_tokens: Some(title_summary_max_tokens(settings)),
        tools: None,
        thinking_budget: None,
        thinking_level: None,
        reasoning_profile: None,
        use_max_completion_tokens,
        thinking_param_style: None,
        extra_body: None,
    };

    let registry = ProviderRegistry::create_default();
    let registry_key = provider_type_to_registry_key(&provider.provider_type);
    let adapter = match registry.get(registry_key) {
        Some(a) => a,
        None => {
            let err = format!("Adapter not found for provider type: {}", registry_key);
            tracing::error!("[title-gen] {}", err);
            return Err(err);
        }
    };

    let mut response = call_title_chat(adapter, ctx, request.clone()).await?;
    let mut title = validated_generated_title(&response.content)?;
    if title.is_empty()
        && request
            .max_tokens
            .is_some_and(|tokens| tokens < RETRY_TITLE_SUMMARY_MAX_TOKENS)
    {
        request.max_tokens = Some(RETRY_TITLE_SUMMARY_MAX_TOKENS);
        tracing::warn!(
            "[title-gen] Empty title returned with a small output budget; retrying with {} tokens",
            RETRY_TITLE_SUMMARY_MAX_TOKENS
        );
        response = call_title_chat(adapter, ctx, request).await?;
        title = validated_generated_title(&response.content)?;
    }

    if title.is_empty() {
        let err = "AI returned empty title".to_string();
        tracing::error!("[title-gen] {}", err);
        Err(err)
    } else {
        tracing::info!("[title-gen] Generated title: {}", title);
        Ok(title)
    }
}

#[tauri::command]
pub async fn regenerate_conversation_title(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conversation_id: String,
) -> Result<(), String> {
    let db = state.sea_db.clone();
    let master_key = state.master_key;

    // Load conversation
    let conversation = aqbot_core::repo::conversation::get_conversation(&db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;

    // Load messages to get first user + assistant content
    let messages = aqbot_core::repo::message::list_messages(&db, &conversation_id)
        .await
        .map_err(|e| e.to_string())?;

    let user_content = messages
        .iter()
        .find(|m| m.role == MessageRole::User)
        .map(|m| m.content.clone())
        .unwrap_or_default();
    let assistant_content = messages
        .iter()
        .find(|m| m.role == MessageRole::Assistant)
        .map(|m| m.content.clone())
        .unwrap_or_default();

    if user_content.is_empty() {
        return Err("No user message found to generate title from".to_string());
    }

    // Load provider for fallback
    let provider = aqbot_core::repo::provider::get_provider(&db, &conversation.provider_id)
        .await
        .map_err(|e| e.to_string())?;
    let key_row = aqbot_core::repo::provider::get_active_key(&db, &provider.id)
        .await
        .map_err(|e| e.to_string())?;
    let decrypted_key = aqbot_core::crypto::decrypt_key(&key_row.key_encrypted, &master_key)
        .map_err(|e| e.to_string())?;

    let global_settings = aqbot_core::repo::settings::get_settings(&db)
        .await
        .map_err(|e| e.to_string())?;

    let resolved_proxy = ProviderProxyConfig::resolve(&provider.proxy_config, &global_settings);
    let ctx = ProviderRequestContext {
        api_key: decrypted_key,
        key_id: key_row.id.clone(),
        provider_id: provider.id.clone(),
        base_url: Some(resolve_base_url_for_type(
            &provider.api_host,
            &provider.provider_type,
        )),
        api_path: provider.api_path.clone(),
        aws_region: provider.aws_region.clone(),
        proxy_config: resolved_proxy,
        custom_headers: provider
            .custom_headers
            .as_ref()
            .and_then(|s| serde_json::from_str(s).ok()),
    };

    // Emit generating event
    let _ = app.emit(
        "conversation-title-generating",
        ConversationTitleGeneratingEvent {
            conversation_id: conversation_id.clone(),
            generating: true,
            error: None,
        },
    );

    // Spawn async task for title generation
    let app_clone = app.clone();
    let conv_id = conversation_id.clone();
    let conv_model_id = conversation.model_id.clone();
    tokio::spawn(async move {
        let ai_title = generate_ai_title(
            &db,
            &user_content,
            &assistant_content,
            &provider,
            &ctx,
            &conv_model_id,
            &global_settings,
            &master_key,
        )
        .await;

        match ai_title {
            Ok(title) => {
                if let Err(e) =
                    aqbot_core::repo::conversation::update_conversation_title(&db, &conv_id, &title)
                        .await
                {
                    tracing::error!("Failed to save regenerated title: {}", e);
                    let _ = app_clone.emit(
                        "conversation-title-generating",
                        ConversationTitleGeneratingEvent {
                            conversation_id: conv_id,
                            generating: false,
                            error: Some(format!("Failed to save title: {}", e)),
                        },
                    );
                } else {
                    let _ = app_clone.emit(
                        "conversation-title-updated",
                        ConversationTitleUpdatedEvent {
                            conversation_id: conv_id.clone(),
                            title,
                        },
                    );
                    let _ = app_clone.emit(
                        "conversation-title-generating",
                        ConversationTitleGeneratingEvent {
                            conversation_id: conv_id,
                            generating: false,
                            error: None,
                        },
                    );
                }
            }
            Err(err) => {
                tracing::warn!("Title regeneration failed: {}", err);
                let _ = app_clone.emit(
                    "conversation-title-generating",
                    ConversationTitleGeneratingEvent {
                        conversation_id: conv_id,
                        generating: false,
                        error: Some(err),
                    },
                );
            }
        }
    });

    Ok(())
}
