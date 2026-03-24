use sea_orm::*;
use sea_query::OnConflict;

use crate::entity::program_policies;
use crate::error::{AQBotError, Result};
use crate::types::{ProgramPolicy, SaveProgramPolicyInput};
use crate::utils::gen_id;

fn model_to_program_policy(m: program_policies::Model) -> ProgramPolicy {
    ProgramPolicy {
        id: m.id,
        program_name: m.program_name,
        allowed_provider_ids_json: m.allowed_provider_ids_json,
        allowed_model_ids_json: m.allowed_model_ids_json,
        default_provider_id: m.default_provider_id,
        default_model_id: m.default_model_id,
        rate_limit_per_minute: m.rate_limit_per_minute.map(|v| v as i32),
    }
}

pub async fn list_program_policies(db: &DatabaseConnection) -> Result<Vec<ProgramPolicy>> {
    let rows = program_policies::Entity::find()
        .order_by_asc(program_policies::Column::ProgramName)
        .all(db)
        .await?;

    Ok(rows.into_iter().map(model_to_program_policy).collect())
}

pub async fn save_program_policy(
    db: &DatabaseConnection,
    input: &SaveProgramPolicyInput,
) -> Result<ProgramPolicy> {
    let id = gen_id();
    let allowed_provider_ids_json =
        serde_json::to_string(&input.allowed_provider_ids).unwrap_or_else(|_| "[]".to_string());
    let allowed_model_ids_json =
        serde_json::to_string(&input.allowed_model_ids).unwrap_or_else(|_| "[]".to_string());

    program_policies::Entity::insert(program_policies::ActiveModel {
        id: Set(id.clone()),
        program_name: Set(input.program_name.clone()),
        allowed_provider_ids_json: Set(allowed_provider_ids_json.clone()),
        allowed_model_ids_json: Set(allowed_model_ids_json.clone()),
        default_provider_id: Set(input.default_provider_id.clone()),
        default_model_id: Set(input.default_model_id.clone()),
        rate_limit_per_minute: Set(input.rate_limit_per_minute.map(|v| v as i64)),
    })
    .on_conflict(
        OnConflict::column(program_policies::Column::ProgramName)
            .update_columns([
                program_policies::Column::AllowedProviderIdsJson,
                program_policies::Column::AllowedModelIdsJson,
                program_policies::Column::DefaultProviderId,
                program_policies::Column::DefaultModelId,
                program_policies::Column::RateLimitPerMinute,
            ])
            .to_owned(),
    )
    .exec(db)
    .await?;

    Ok(ProgramPolicy {
        id,
        program_name: input.program_name.clone(),
        allowed_provider_ids_json,
        allowed_model_ids_json,
        default_provider_id: input.default_provider_id.clone(),
        default_model_id: input.default_model_id.clone(),
        rate_limit_per_minute: input.rate_limit_per_minute,
    })
}

pub async fn delete_program_policy(db: &DatabaseConnection, id: &str) -> Result<()> {
    let result = program_policies::Entity::delete_by_id(id)
        .exec(db)
        .await?;

    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("ProgramPolicy {}", id)));
    }

    Ok(())
}
