use sea_orm::*;

use crate::entity::context_sources;
use crate::error::{AQBotError, Result};
use crate::types::{ContextSource, CreateContextSourceInput};
use crate::utils::gen_id;

fn model_to_context_source(m: context_sources::Model) -> ContextSource {
    ContextSource {
        id: m.id,
        conversation_id: m.conversation_id,
        message_id: m.message_id,
        source_type: m.source_type,
        ref_id: m.ref_id,
        title: m.title,
        enabled: m.enabled != 0,
        summary: m.summary,
    }
}

pub async fn list_context_sources(
    db: &DatabaseConnection,
    conversation_id: &str,
) -> Result<Vec<ContextSource>> {
    let models = context_sources::Entity::find()
        .filter(context_sources::Column::ConversationId.eq(conversation_id))
        .all(db)
        .await?;

    Ok(models.into_iter().map(model_to_context_source).collect())
}

pub async fn get_context_source(db: &DatabaseConnection, id: &str) -> Result<ContextSource> {
    let model = context_sources::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("ContextSource {}", id)))?;

    Ok(model_to_context_source(model))
}

pub async fn add_context_source(
    db: &DatabaseConnection,
    input: &CreateContextSourceInput,
) -> Result<ContextSource> {
    let id = gen_id();

    let am = context_sources::ActiveModel {
        id: Set(id.clone()),
        conversation_id: Set(input.conversation_id.clone()),
        message_id: Set(input.message_id.clone()),
        source_type: Set(input.source_type.clone()),
        ref_id: Set(input.ref_id.clone()),
        title: Set(input.title.clone()),
        enabled: Set(1),
        summary: Set(input.summary.clone()),
    };

    am.insert(db).await?;

    get_context_source(db, &id).await
}

pub async fn remove_context_source(db: &DatabaseConnection, id: &str) -> Result<()> {
    let result = context_sources::Entity::delete_by_id(id).exec(db).await?;

    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("ContextSource {}", id)));
    }
    Ok(())
}

pub async fn toggle_context_source(
    db: &DatabaseConnection,
    id: &str,
) -> Result<ContextSource> {
    let model = context_sources::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("ContextSource {}", id)))?;

    let new_enabled = if model.enabled != 0 { 0 } else { 1 };
    let mut am: context_sources::ActiveModel = model.into();
    am.enabled = Set(new_enabled);
    am.update(db).await?;

    get_context_source(db, id).await
}
