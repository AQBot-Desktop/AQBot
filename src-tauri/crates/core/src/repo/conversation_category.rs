use sea_orm::prelude::Expr;
use sea_orm::*;

use crate::entity::conversation_categories;
use crate::error::{AQBotError, Result};
use crate::types::{
    ConversationCategory, CreateConversationCategoryInput, UpdateConversationCategoryInput,
};
use crate::utils::{gen_id, now_ts};

fn category_from_entity(m: conversation_categories::Model) -> ConversationCategory {
    ConversationCategory {
        id: m.id,
        name: m.name,
        icon_type: m.icon_type,
        icon_value: m.icon_value,
        system_prompt: m.system_prompt,
        default_provider_id: m.default_provider_id,
        default_model_id: m.default_model_id,
        default_temperature: m.default_temperature,
        default_max_tokens: m.default_max_tokens,
        default_top_p: m.default_top_p,
        default_frequency_penalty: m.default_frequency_penalty,
        sort_order: m.sort_order,
        is_collapsed: m.is_collapsed != 0,
        created_at: m.created_at,
        updated_at: m.updated_at,
    }
}

pub async fn list_conversation_categories(
    db: &DatabaseConnection,
) -> Result<Vec<ConversationCategory>> {
    let rows = conversation_categories::Entity::find()
        .order_by_asc(conversation_categories::Column::SortOrder)
        .all(db)
        .await?;
    Ok(rows.into_iter().map(category_from_entity).collect())
}

pub async fn create_conversation_category(
    db: &DatabaseConnection,
    input: CreateConversationCategoryInput,
) -> Result<ConversationCategory> {
    let id = gen_id();
    let now = now_ts();

    let max_order = conversation_categories::Entity::find()
        .select_only()
        .column_as(conversation_categories::Column::SortOrder.max(), "m")
        .into_tuple::<Option<i32>>()
        .one(db)
        .await?
        .flatten();
    let sort_order = max_order.unwrap_or(-1) + 1;

    let am = conversation_categories::ActiveModel {
        id: Set(id),
        name: Set(input.name),
        icon_type: Set(input.icon_type),
        icon_value: Set(input.icon_value),
        system_prompt: Set(input.system_prompt),
        default_provider_id: Set(input.default_provider_id),
        default_model_id: Set(input.default_model_id),
        default_temperature: Set(input.default_temperature),
        default_max_tokens: Set(input.default_max_tokens),
        default_top_p: Set(input.default_top_p),
        default_frequency_penalty: Set(input.default_frequency_penalty),
        sort_order: Set(sort_order),
        is_collapsed: Set(1),
        created_at: Set(now),
        updated_at: Set(now),
    };
    let row = am.insert(db).await?;
    Ok(category_from_entity(row))
}

pub async fn update_conversation_category(
    db: &DatabaseConnection,
    id: &str,
    input: UpdateConversationCategoryInput,
) -> Result<ConversationCategory> {
    let row = conversation_categories::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("ConversationCategory {}", id)))?;

    let mut am: conversation_categories::ActiveModel = row.into();
    if let Some(name) = input.name {
        am.name = Set(name);
    }
    if let Some(icon_type) = input.icon_type {
        am.icon_type = Set(icon_type);
    }
    if let Some(icon_value) = input.icon_value {
        am.icon_value = Set(icon_value);
    }
    if let Some(system_prompt) = input.system_prompt {
        am.system_prompt = Set(system_prompt);
    }
    if let Some(default_provider_id) = input.default_provider_id {
        am.default_provider_id = Set(default_provider_id);
    }
    if let Some(default_model_id) = input.default_model_id {
        am.default_model_id = Set(default_model_id);
    }
    if let Some(default_temperature) = input.default_temperature {
        am.default_temperature = Set(default_temperature);
    }
    if let Some(default_max_tokens) = input.default_max_tokens {
        am.default_max_tokens = Set(default_max_tokens);
    }
    if let Some(default_top_p) = input.default_top_p {
        am.default_top_p = Set(default_top_p);
    }
    if let Some(default_frequency_penalty) = input.default_frequency_penalty {
        am.default_frequency_penalty = Set(default_frequency_penalty);
    }
    am.updated_at = Set(now_ts());
    am.update(db).await?;

    let updated = conversation_categories::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("ConversationCategory {}", id)))?;
    Ok(category_from_entity(updated))
}

pub async fn delete_conversation_category(db: &DatabaseConnection, id: &str) -> Result<()> {
    use crate::entity::conversations;
    let txn = db.begin().await?;
    let operation = async {
        if conversation_categories::Entity::find_by_id(id)
            .one(&txn)
            .await?
            .is_none()
        {
            return Err(AQBotError::NotFound(format!("ConversationCategory {id}")));
        }

        let roots = conversations::Entity::find()
            .filter(conversations::Column::CategoryId.eq(id))
            .filter(conversations::Column::IsArchived.eq(0))
            .filter(conversations::Column::ParentConversationId.is_null())
            .order_by_asc(conversations::Column::SortOrder)
            .order_by_desc(conversations::Column::UpdatedAt)
            .order_by_asc(conversations::Column::Id)
            .all(&txn)
            .await?;
        let pinned_ids = roots
            .iter()
            .filter(|row| row.is_pinned != 0)
            .map(|row| row.id.clone())
            .collect::<Vec<_>>();
        let unpinned_ids = roots
            .iter()
            .filter(|row| row.is_pinned == 0)
            .map(|row| row.id.clone())
            .collect::<Vec<_>>();
        crate::repo::conversation::place_existing_roots_at_top(&txn, None, true, &pinned_ids)
            .await?;
        crate::repo::conversation::place_existing_roots_at_top(&txn, None, false, &unpinned_ids)
            .await?;

        conversations::Entity::update_many()
            .col_expr(
                conversations::Column::CategoryId,
                Expr::value(Option::<String>::None),
            )
            .filter(conversations::Column::CategoryId.eq(id))
            .exec(&txn)
            .await?;
        let deleted = conversation_categories::Entity::delete_by_id(id)
            .exec(&txn)
            .await?;
        if deleted.rows_affected != 1 {
            return Err(AQBotError::NotFound(format!("ConversationCategory {id}")));
        }
        Ok(())
    }
    .await;
    if let Err(error) = operation {
        let rollback = txn.rollback().await.err();
        return Err(match rollback {
            None => error,
            Some(rollback) => {
                AQBotError::Validation(format!("{error}; transaction rollback failed: {rollback}"))
            }
        });
    }
    txn.commit().await?;
    Ok(())
}

pub async fn reorder_conversation_categories(
    db: &DatabaseConnection,
    category_ids: &[String],
) -> Result<()> {
    let now = now_ts();
    for (i, id) in category_ids.iter().enumerate() {
        conversation_categories::Entity::update_many()
            .col_expr(
                conversation_categories::Column::SortOrder,
                Expr::value(i as i32),
            )
            .col_expr(conversation_categories::Column::UpdatedAt, Expr::value(now))
            .filter(conversation_categories::Column::Id.eq(id))
            .exec(db)
            .await?;
    }
    Ok(())
}

pub async fn set_conversation_category_collapsed(
    db: &DatabaseConnection,
    id: &str,
    collapsed: bool,
) -> Result<()> {
    let row = conversation_categories::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("ConversationCategory {}", id)))?;

    let mut am: conversation_categories::ActiveModel = row.into();
    am.is_collapsed = Set(if collapsed { 1 } else { 0 });
    am.updated_at = Set(now_ts());
    am.update(db).await?;
    Ok(())
}
