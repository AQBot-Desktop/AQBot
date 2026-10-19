use aqbot_core::repo::message;

/// A regenerated version may replace the active answer or remain a companion.
pub(super) struct AgentRegeneration<'a> {
    pub conversation_id: &'a str,
    pub user_message_id: &'a str,
    pub provider_id: &'a str,
    pub model_id: &'a str,
    pub is_active: bool,
}

pub(super) async fn create_agent_regen_placeholder(
    db: &sea_orm::DatabaseConnection,
    input: AgentRegeneration<'_>,
) -> Result<String, String> {
    let existing_versions =
        message::list_message_versions(db, input.conversation_id, input.user_message_id)
            .await
            .map_err(|e| e.to_string())?;
    let message_id = aqbot_core::utils::gen_id();
    super::conversations::persist_assistant_placeholder(
        db,
        super::conversations::AssistantPlaceholderPersistence {
            conversation_id: input.conversation_id,
            message_id: &message_id,
            parent_message_id: input.user_message_id,
            provider_id: input.provider_id,
            model_id: input.model_id,
            content: "",
            version_index: existing_versions.len() as i32,
            created_at: existing_versions
                .first()
                .map(|version| version.created_at)
                .unwrap_or_else(aqbot_core::utils::now_ts),
            deactivate_existing_versions: input.is_active,
            increment_message_count: false,
            is_active: input.is_active,
        },
    )
    .await?;
    Ok(message_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use aqbot_core::repo::conversation;
    use aqbot_core::types::MessageRole;

    #[tokio::test]
    async fn companion_placeholder_preserves_the_active_version() {
        let db = aqbot_core::db::create_test_pool().await.unwrap().conn;
        let conversation =
            conversation::create_conversation(&db, "Agent", "model", "provider", None)
                .await
                .unwrap();
        let user = message::create_message(
            &db,
            &conversation.id,
            MessageRole::User,
            "prompt",
            &[],
            None,
            0,
        )
        .await
        .unwrap();
        let active = message::create_message(
            &db,
            &conversation.id,
            MessageRole::Assistant,
            "active",
            &[],
            Some(&user.id),
            0,
        )
        .await
        .unwrap();
        let companion = create_agent_regen_placeholder(
            &db,
            AgentRegeneration {
                conversation_id: &conversation.id,
                user_message_id: &user.id,
                provider_id: "provider",
                model_id: "other-model",
                is_active: false,
            },
        )
        .await
        .unwrap();
        assert!(
            message::get_message(&db, &active.id)
                .await
                .unwrap()
                .is_active
        );
        let saved = message::get_message(&db, &companion).await.unwrap();
        assert!(!saved.is_active);
        assert_eq!(saved.version_index, 1);
        assert_eq!(saved.created_at, active.created_at);
        assert_eq!(saved.model_id.as_deref(), Some("other-model"));

        let replacement = create_agent_regen_placeholder(
            &db,
            AgentRegeneration {
                conversation_id: &conversation.id,
                user_message_id: &user.id,
                provider_id: "provider",
                model_id: "other-model",
                is_active: true,
            },
        )
        .await
        .unwrap();
        assert!(
            !message::get_message(&db, &active.id)
                .await
                .unwrap()
                .is_active
        );
        assert!(
            !message::get_message(&db, &companion)
                .await
                .unwrap()
                .is_active
        );
        assert!(
            message::get_message(&db, &replacement)
                .await
                .unwrap()
                .is_active
        );
    }
}
