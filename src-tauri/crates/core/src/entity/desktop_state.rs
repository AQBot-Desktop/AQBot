use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "desktop_state")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub window_key: String,
    pub width: i32,
    pub height: i32,
    pub x: Option<i64>,
    pub y: Option<i64>,
    pub maximized: i32,
    pub visible: i32,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
