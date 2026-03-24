use sea_orm::*;
use sea_query::OnConflict;

use crate::entity::settings;
use crate::error::{AQBotError, Result};
use crate::types::AppSettings;

pub async fn get_settings(db: &DatabaseConnection) -> Result<AppSettings> {
    let rows = settings::Entity::find().all(db).await?;

    let mut map = serde_json::Map::new();
    for row in &rows {
        let val = serde_json::from_str::<serde_json::Value>(&row.value)
            .unwrap_or_else(|_| serde_json::Value::String(row.value.clone()));
        map.insert(row.key.clone(), val);
    }

    let settings: AppSettings =
        serde_json::from_value(serde_json::Value::Object(map)).unwrap_or_default();
    Ok(settings)
}

pub async fn save_settings(db: &DatabaseConnection, settings: &AppSettings) -> Result<()> {
    let value = serde_json::to_value(settings).unwrap_or_default();

    if let serde_json::Value::Object(map) = value {
        db.transaction::<_, _, sea_orm::DbErr>(|txn| {
            Box::pin(async move {
                for (key, val) in map {
                    let val_str = match &val {
                        serde_json::Value::String(s) => s.clone(),
                        other => other.to_string(),
                    };
                    settings::Entity::insert(settings::ActiveModel {
                        key: Set(key),
                        value: Set(val_str),
                    })
                    .on_conflict(
                        OnConflict::column(settings::Column::Key)
                            .update_column(settings::Column::Value)
                            .to_owned(),
                    )
                    .exec(txn)
                    .await?;
                }
                Ok(())
            })
        })
        .await
        .map_err(|e| match e {
            sea_orm::TransactionError::Connection(db_err) => AQBotError::from(db_err),
            sea_orm::TransactionError::Transaction(db_err) => AQBotError::from(db_err),
        })?;
    }
    Ok(())
}

pub async fn get_setting(db: &DatabaseConnection, key: &str) -> Result<Option<String>> {
    let row = settings::Entity::find_by_id(key).one(db).await?;
    Ok(row.map(|r| r.value))
}

pub async fn set_setting(db: &DatabaseConnection, key: &str, value: &str) -> Result<()> {
    settings::Entity::insert(settings::ActiveModel {
        key: Set(key.to_string()),
        value: Set(value.to_string()),
    })
    .on_conflict(
        OnConflict::column(settings::Column::Key)
            .update_column(settings::Column::Value)
            .to_owned(),
    )
    .exec(db)
    .await?;
    Ok(())
}
