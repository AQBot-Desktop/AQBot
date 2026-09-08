use sea_orm::*;
use sea_query::OnConflict;

use crate::entity::settings;
use crate::error::{AQBotError, Result};
use crate::types::{AppSettings, MAX_COMPRESSION_KEEP_LAST_N};

pub async fn get_settings(db: &DatabaseConnection) -> Result<AppSettings> {
    let rows = settings::Entity::find().all(db).await?;

    let mut map = serde_json::Map::new();
    for row in &rows {
        let val = serde_json::from_str::<serde_json::Value>(&row.value)
            .unwrap_or_else(|_| serde_json::Value::String(row.value.clone()));
        map.insert(row.key.clone(), val);
    }

    let mut settings: AppSettings = serde_json::from_value(serde_json::Value::Object(map))
        .map_err(|error| {
            AQBotError::Validation(format!("Invalid stored application settings: {error}"))
        })?;
    // Stored prompts that still equal an older default follow the current one.
    settings.selection_toolbar.upgrade_legacy_defaults();
    Ok(settings)
}

pub async fn save_settings(db: &DatabaseConnection, settings: &AppSettings) -> Result<()> {
    let model_test_prompt =
        crate::types::normalize_model_test_prompt(settings.model_test_prompt.as_deref())
            .map_err(AQBotError::Validation)?;
    if settings
        .default_compression_keep_last_n
        .is_some_and(|value| value > MAX_COMPRESSION_KEEP_LAST_N)
    {
        return Err(AQBotError::Validation(format!(
            "default_compression_keep_last_n must be between 0 and {MAX_COMPRESSION_KEEP_LAST_N}"
        )));
    }

    let value = serde_json::to_value(settings).map_err(|error| {
        AQBotError::Validation(format!("Failed to serialize application settings: {error}"))
    })?;
    let serde_json::Value::Object(mut map) = value else {
        return Err(AQBotError::Validation(
            "Application settings must serialize to an object".to_string(),
        ));
    };
    map.insert(
        "model_test_prompt".into(),
        serde_json::json!(model_test_prompt),
    );
    map.remove(super::multi_model_column_layout::MAIN_WIDTH_MODE_KEY);
    map.remove(super::multi_model_column_layout::POPOUT_WIDTH_MODE_KEY);
    // Only the transactional tray-image commands may change these keys.
    map.remove(super::tray_icon::FILE_ID_KEY);
    map.remove(super::tray_icon::SCOPE_KEY);

    db.transaction::<_, _, sea_orm::DbErr>(|txn| {
        Box::pin(async move {
            for (key, val) in map {
                let val_str = match &val {
                    _ if key == "model_test_prompt" => val.to_string(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::create_test_pool;

    #[tokio::test]
    async fn model_test_prompt_is_normalized_validated_and_roundtrips_json_like_text() {
        let h = create_test_pool().await.unwrap();
        for value in ["  123  ", "null", "\"question\"", "你好"] {
            let settings = AppSettings {
                model_test_prompt: Some(value.into()),
                ..Default::default()
            };
            save_settings(&h.conn, &settings).await.unwrap();
            assert_eq!(
                get_settings(&h.conn)
                    .await
                    .unwrap()
                    .model_test_prompt
                    .as_deref(),
                Some(value.trim())
            );
        }
        let settings = AppSettings {
            model_test_prompt: Some("测".repeat(crate::types::MODEL_TEST_MAX_PROMPT_CHARS + 1)),
            ..Default::default()
        };
        assert!(save_settings(&h.conn, &settings).await.is_err());
        assert_eq!(
            get_settings(&h.conn)
                .await
                .unwrap()
                .model_test_prompt
                .as_deref(),
            Some("你好")
        );
        let settings = AppSettings {
            model_test_prompt: Some(" \n ".into()),
            ..Default::default()
        };
        save_settings(&h.conn, &settings).await.unwrap();
        assert_eq!(get_settings(&h.conn).await.unwrap().model_test_prompt, None);
    }

    #[tokio::test]
    async fn save_settings_enforces_compression_keep_last_n_limit() {
        let h = create_test_pool().await.unwrap();
        let mut settings = AppSettings::default();
        settings.default_compression_keep_last_n = Some(MAX_COMPRESSION_KEEP_LAST_N);
        save_settings(&h.conn, &settings).await.unwrap();
        assert_eq!(
            get_settings(&h.conn)
                .await
                .unwrap()
                .default_compression_keep_last_n,
            Some(MAX_COMPRESSION_KEEP_LAST_N)
        );

        settings.default_compression_keep_last_n = Some(MAX_COMPRESSION_KEEP_LAST_N + 1);

        let error = save_settings(&h.conn, &settings).await.unwrap_err();

        assert!(error
            .to_string()
            .contains("default_compression_keep_last_n"));
    }

    #[tokio::test]
    async fn get_settings_rejects_invalid_context_strategy_instead_of_resetting_everything() {
        let h = create_test_pool().await.unwrap();
        set_setting(&h.conn, "default_context_strategy", "not_a_strategy")
            .await
            .unwrap();

        let error = get_settings(&h.conn).await.unwrap_err();

        assert!(error
            .to_string()
            .contains("Invalid stored application settings"));
    }
}
