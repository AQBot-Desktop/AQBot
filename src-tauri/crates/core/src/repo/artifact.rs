use sea_orm::*;

use crate::entity::artifacts;
use crate::error::{AQBotError, Result};
use crate::types::{Artifact, CreateArtifactInput, UpdateArtifactInput};
use crate::utils::gen_id;

fn now_datetime() -> String {
    chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string()
}

fn model_to_artifact(m: artifacts::Model) -> Artifact {
    Artifact {
        id: m.id,
        conversation_id: m.conversation_id,
        kind: m.kind,
        title: m.title,
        content: m.content,
        format: m.format,
        pinned: m.pinned != 0,
        updated_at: m.updated_at,
    }
}

pub async fn list_artifacts(
    db: &DatabaseConnection,
    conversation_id: &str,
) -> Result<Vec<Artifact>> {
    let models = artifacts::Entity::find()
        .filter(artifacts::Column::ConversationId.eq(conversation_id))
        .order_by_desc(artifacts::Column::UpdatedAt)
        .all(db)
        .await?;

    Ok(models.into_iter().map(model_to_artifact).collect())
}

pub async fn get_artifact(db: &DatabaseConnection, id: &str) -> Result<Artifact> {
    let model = artifacts::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Artifact {}", id)))?;

    Ok(model_to_artifact(model))
}

pub async fn create_artifact(
    db: &DatabaseConnection,
    input: &CreateArtifactInput,
) -> Result<Artifact> {
    let id = gen_id();

    let am = artifacts::ActiveModel {
        id: Set(id.clone()),
        conversation_id: Set(input.conversation_id.clone()),
        kind: Set(input.kind.clone()),
        title: Set(input.title.clone()),
        content: Set(input.content.clone()),
        format: Set(input.format.clone()),
        pinned: Set(0),
        updated_at: Set(now_datetime()),
    };

    am.insert(db).await?;

    get_artifact(db, &id).await
}

pub async fn update_artifact(
    db: &DatabaseConnection,
    id: &str,
    input: &UpdateArtifactInput,
) -> Result<Artifact> {
    let model = artifacts::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("Artifact {}", id)))?;

    let existing = model_to_artifact(model.clone());

    let mut am: artifacts::ActiveModel = model.into();
    am.title = Set(input.title.clone().unwrap_or(existing.title));
    am.content = Set(input.content.clone().unwrap_or(existing.content));
    am.format = Set(input.format.clone().unwrap_or(existing.format));
    am.pinned = Set(if input.pinned.unwrap_or(existing.pinned) { 1 } else { 0 });
    am.updated_at = Set(now_datetime());
    am.update(db).await?;

    get_artifact(db, id).await
}

pub async fn delete_artifact(db: &DatabaseConnection, id: &str) -> Result<()> {
    let result = artifacts::Entity::delete_by_id(id).exec(db).await?;

    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("Artifact {}", id)));
    }
    Ok(())
}
