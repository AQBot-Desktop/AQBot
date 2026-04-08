use sea_orm::*;
use sea_orm::prelude::Expr;
use std::collections::HashSet;

use crate::entity::skill_states;
use crate::error::Result;
use crate::utils::now_ts;

/// Get all disabled skill names from the database.
pub async fn get_disabled_skills(db: &DatabaseConnection) -> Result<HashSet<String>> {
    let rows = skill_states::Entity::find()
        .filter(skill_states::Column::Enabled.eq(0))
        .all(db)
        .await?;
    Ok(rows.into_iter().map(|r| r.name).collect())
}

/// Set a skill's enabled state. Creates or updates the record.
pub async fn set_skill_enabled(
    db: &DatabaseConnection,
    name: &str,
    enabled: bool,
) -> Result<()> {
    let now = now_ts();
    let existing = skill_states::Entity::find_by_id(name).one(db).await?;

    if let Some(_) = existing {
        skill_states::Entity::update_many()
            .col_expr(
                skill_states::Column::Enabled,
                Expr::value(if enabled { 1 } else { 0 }),
            )
            .col_expr(skill_states::Column::UpdatedAt, Expr::value(now))
            .filter(skill_states::Column::Name.eq(name))
            .exec(db)
            .await?;
    } else {
        let am = skill_states::ActiveModel {
            name: Set(name.to_string()),
            enabled: Set(if enabled { 1 } else { 0 }),
            updated_at: Set(now),
        };
        am.insert(db).await?;
    }
    Ok(())
}
