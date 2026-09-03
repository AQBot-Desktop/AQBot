use std::collections::BTreeMap;

use sea_orm::*;
use sea_query::OnConflict;
use serde::{Deserialize, Serialize};

use crate::entity::settings;
use crate::error::{AQBotError, Result};
use crate::types::MultiModelSideBySideWidthMode;

pub const MAIN_WIDTH_MODE_KEY: &str = "multi_model_side_by_side_width_mode";
pub const POPOUT_WIDTH_MODE_KEY: &str = "multi_model_popout_side_by_side_width_mode";
pub const COLUMN_WIDTH_PREFIX: &str = "multi_model_column_width:";
pub const CUSTOM_MIN_WIDTH_PX: i32 = 320;
pub const CUSTOM_MAX_WIDTH_PX: i32 = 10_000;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum MultiModelColumnLayoutView {
    Main,
    Popout,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MultiModelColumnLayout {
    pub main_width_mode: MultiModelSideBySideWidthMode,
    pub popout_width_mode: MultiModelSideBySideWidthMode,
    pub column_widths: BTreeMap<String, i32>,
}

impl Default for MultiModelColumnLayout {
    fn default() -> Self {
        Self {
            main_width_mode: MultiModelSideBySideWidthMode::Scroll,
            popout_width_mode: MultiModelSideBySideWidthMode::Scroll,
            column_widths: BTreeMap::new(),
        }
    }
}

fn mode_key(view: MultiModelColumnLayoutView) -> &'static str {
    match view {
        MultiModelColumnLayoutView::Main => MAIN_WIDTH_MODE_KEY,
        MultiModelColumnLayoutView::Popout => POPOUT_WIDTH_MODE_KEY,
    }
}

fn parse_mode(value: Option<String>) -> Result<MultiModelSideBySideWidthMode> {
    match value.as_deref() {
        None | Some("scroll") => Ok(MultiModelSideBySideWidthMode::Scroll),
        Some("fit") => Ok(MultiModelSideBySideWidthMode::Fit),
        Some(other) => Err(AQBotError::Validation(format!(
            "invalid multi-model width mode: {other}"
        ))),
    }
}

fn mode_value(mode: MultiModelSideBySideWidthMode) -> &'static str {
    match mode {
        MultiModelSideBySideWidthMode::Fit => "fit",
        MultiModelSideBySideWidthMode::Scroll => "scroll",
    }
}

fn column_width_key(provider_id: &str, model_id: &str) -> Result<String> {
    if provider_id.is_empty() || model_id.is_empty() {
        return Err(AQBotError::Validation(
            "provider_id and model_id are required".to_string(),
        ));
    }
    if provider_id.contains(':') {
        return Err(AQBotError::Validation(
            "provider_id must not contain ':'".to_string(),
        ));
    }
    Ok(format!("{COLUMN_WIDTH_PREFIX}{provider_id}:{model_id}"))
}

fn parse_column_width_key(key: &str) -> Option<String> {
    key.strip_prefix(COLUMN_WIDTH_PREFIX)
        .filter(|rest| rest.contains(':'))
        .map(ToString::to_string)
}

fn parse_width_px(raw: &str) -> Result<i32> {
    let width = raw
        .parse::<i32>()
        .map_err(|_| AQBotError::Validation(format!("invalid column width: {raw}")))?;
    if width < CUSTOM_MIN_WIDTH_PX || width > CUSTOM_MAX_WIDTH_PX {
        return Err(AQBotError::Validation(format!(
            "column width must be {CUSTOM_MIN_WIDTH_PX}..={CUSTOM_MAX_WIDTH_PX}"
        )));
    }
    Ok(width)
}

pub async fn get_layout(db: &DatabaseConnection) -> Result<MultiModelColumnLayout> {
    let rows = settings::Entity::find()
        .filter(
            Condition::any()
                .add(settings::Column::Key.is_in([MAIN_WIDTH_MODE_KEY, POPOUT_WIDTH_MODE_KEY]))
                .add(settings::Column::Key.like(format!("{COLUMN_WIDTH_PREFIX}%"))),
        )
        .all(db)
        .await?;

    let mut layout = MultiModelColumnLayout::default();
    for row in rows {
        if row.key == MAIN_WIDTH_MODE_KEY {
            layout.main_width_mode = parse_mode(Some(row.value))?;
        } else if row.key == POPOUT_WIDTH_MODE_KEY {
            layout.popout_width_mode = parse_mode(Some(row.value))?;
        } else if let Some(model_key) = parse_column_width_key(&row.key) {
            layout.column_widths.insert(model_key, parse_width_px(&row.value)?);
        }
    }
    Ok(layout)
}

pub async fn set_width_mode(
    db: &DatabaseConnection,
    view: MultiModelColumnLayoutView,
    mode: MultiModelSideBySideWidthMode,
) -> Result<MultiModelColumnLayout> {
    super::settings::set_setting(db, mode_key(view), mode_value(mode)).await?;
    get_layout(db).await
}

pub async fn set_column_width(
    db: &DatabaseConnection,
    view: MultiModelColumnLayoutView,
    provider_id: &str,
    model_id: &str,
    width_px: Option<i32>,
) -> Result<MultiModelColumnLayout> {
    let key = column_width_key(provider_id, model_id)?;
    let switch_to_scroll = width_px.is_some();
    let width_value = width_px.map(parse_width_px_value).transpose()?;
    let mode_key = mode_key(view);

    db.transaction::<_, _, sea_orm::DbErr>(|txn| {
        Box::pin(async move {
            if switch_to_scroll {
                settings::Entity::insert(settings::ActiveModel {
                    key: Set(mode_key.to_string()),
                    value: Set(mode_value(MultiModelSideBySideWidthMode::Scroll).to_string()),
                })
                .on_conflict(
                    OnConflict::column(settings::Column::Key)
                        .update_column(settings::Column::Value)
                        .to_owned(),
                )
                .exec(txn)
                .await?;
            }
            if let Some(width) = width_value {
                settings::Entity::insert(settings::ActiveModel {
                    key: Set(key.clone()),
                    value: Set(width.to_string()),
                })
                .on_conflict(
                    OnConflict::column(settings::Column::Key)
                        .update_column(settings::Column::Value)
                        .to_owned(),
                )
                .exec(txn)
                .await?;
            } else {
                settings::Entity::delete_by_id(key).exec(txn).await?;
            }
            Ok(())
        })
    })
    .await?;

    get_layout(db).await
}

fn parse_width_px_value(width: i32) -> Result<i32> {
    if width < CUSTOM_MIN_WIDTH_PX || width > CUSTOM_MAX_WIDTH_PX {
        return Err(AQBotError::Validation(format!(
            "column width must be {CUSTOM_MIN_WIDTH_PX}..={CUSTOM_MAX_WIDTH_PX}"
        )));
    }
    Ok(width)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::create_test_pool;
    use crate::types::AppSettings;

    #[tokio::test]
    async fn save_settings_does_not_overwrite_layout_modes() {
        let handle = create_test_pool().await.unwrap();
        set_width_mode(
            &handle.conn,
            MultiModelColumnLayoutView::Main,
            MultiModelSideBySideWidthMode::Fit,
        )
        .await
        .unwrap();
        set_width_mode(
            &handle.conn,
            MultiModelColumnLayoutView::Popout,
            MultiModelSideBySideWidthMode::Fit,
        )
        .await
        .unwrap();

        let mut settings = AppSettings::default();
        settings.multi_model_side_by_side_width_mode = MultiModelSideBySideWidthMode::Scroll;
        settings.multi_model_popout_side_by_side_width_mode = MultiModelSideBySideWidthMode::Scroll;
        crate::repo::settings::save_settings(&handle.conn, &settings)
            .await
            .unwrap();

        let layout = get_layout(&handle.conn).await.unwrap();
        assert_eq!(layout.main_width_mode, MultiModelSideBySideWidthMode::Fit);
        assert_eq!(layout.popout_width_mode, MultiModelSideBySideWidthMode::Fit);
    }

    #[tokio::test]
    async fn saving_a_width_switches_only_that_view_to_scroll() {
        let handle = create_test_pool().await.unwrap();
        set_width_mode(
            &handle.conn,
            MultiModelColumnLayoutView::Main,
            MultiModelSideBySideWidthMode::Fit,
        )
        .await
        .unwrap();
        set_width_mode(
            &handle.conn,
            MultiModelColumnLayoutView::Popout,
            MultiModelSideBySideWidthMode::Fit,
        )
        .await
        .unwrap();

        let layout = set_column_width(
            &handle.conn,
            MultiModelColumnLayoutView::Main,
            "provider-a",
            "model-a",
            Some(640),
        )
        .await
        .unwrap();

        assert_eq!(layout.main_width_mode, MultiModelSideBySideWidthMode::Scroll);
        assert_eq!(layout.popout_width_mode, MultiModelSideBySideWidthMode::Fit);
        assert_eq!(layout.column_widths.get("provider-a:model-a"), Some(&640));
    }

    #[tokio::test]
    async fn clearing_a_width_restores_the_default_without_touching_other_models() {
        let handle = create_test_pool().await.unwrap();
        set_column_width(
            &handle.conn,
            MultiModelColumnLayoutView::Main,
            "provider-a",
            "model-a",
            Some(640),
        )
        .await
        .unwrap();
        set_column_width(
            &handle.conn,
            MultiModelColumnLayoutView::Popout,
            "provider-b",
            "model-a",
            Some(720),
        )
        .await
        .unwrap();

        let layout = set_column_width(
            &handle.conn,
            MultiModelColumnLayoutView::Main,
            "provider-a",
            "model-a",
            None,
        )
        .await
        .unwrap();

        assert!(layout.column_widths.get("provider-a:model-a").is_none());
        assert_eq!(layout.column_widths.get("provider-b:model-a"), Some(&720));
    }
}
