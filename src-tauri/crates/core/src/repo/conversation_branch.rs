use sea_orm::*;

use crate::entity::conversation_branches;
use crate::error::{AQBotError, Result};
use crate::types::ConversationBranch;
use crate::utils::gen_id;

fn model_to_branch(m: conversation_branches::Model) -> ConversationBranch {
    ConversationBranch {
        id: m.id,
        conversation_id: m.conversation_id,
        parent_message_id: m.parent_message_id,
        branch_label: m.branch_label,
        branch_index: m.branch_index,
        compared_message_ids_json: m.compared_message_ids_json,
        created_at: m.created_at,
    }
}

pub async fn list_branches(
    db: &DatabaseConnection,
    conversation_id: &str,
) -> Result<Vec<ConversationBranch>> {
    let models = conversation_branches::Entity::find()
        .filter(conversation_branches::Column::ConversationId.eq(conversation_id))
        .order_by_asc(conversation_branches::Column::BranchIndex)
        .all(db)
        .await?;

    Ok(models.into_iter().map(model_to_branch).collect())
}

pub async fn get_branch(db: &DatabaseConnection, id: &str) -> Result<ConversationBranch> {
    let model = conversation_branches::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("ConversationBranch {}", id)))?;

    Ok(model_to_branch(model))
}

pub async fn create_branch(
    db: &DatabaseConnection,
    conversation_id: &str,
    parent_message_id: &str,
    label: &str,
) -> Result<ConversationBranch> {
    let id = gen_id();

    let count = conversation_branches::Entity::find()
        .filter(conversation_branches::Column::ConversationId.eq(conversation_id))
        .count(db)
        .await? as i32;

    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();

    let am = conversation_branches::ActiveModel {
        id: Set(id.clone()),
        conversation_id: Set(conversation_id.to_string()),
        parent_message_id: Set(parent_message_id.to_string()),
        branch_label: Set(label.to_string()),
        branch_index: Set(count),
        compared_message_ids_json: Set(None),
        created_at: Set(now),
    };

    am.insert(db).await?;

    get_branch(db, &id).await
}
