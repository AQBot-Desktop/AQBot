use sea_orm::entity::prelude::*;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, DeriveEntityModel, Serialize, Deserialize)]
#[sea_orm(table_name = "backup_manifests")]
pub struct Model {
    #[sea_orm(primary_key, auto_increment = false)]
    pub id: String,
    pub version: String,
    pub created_at: String,
    pub encrypted: i32,
    pub checksum: String,
    #[sea_orm(column_type = "Text")]
    pub object_counts_json: String,
    pub source_app_version: String,
    pub file_path: Option<String>,
    pub file_size: i64,
}

#[derive(Copy, Clone, Debug, EnumIter, DeriveRelation)]
pub enum Relation {}

impl ActiveModelBehavior for ActiveModel {}
