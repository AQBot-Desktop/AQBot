use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        add_column(
            manager,
            "models",
            "image_config_json",
            ImageColumnType::Text,
        )
        .await?;
        add_column(
            manager,
            "drawing_generations",
            "adapter_id",
            ImageColumnType::String,
        )
        .await?;
        add_column(
            manager,
            "drawing_generations",
            "adapter_config_snapshot",
            ImageColumnType::Text,
        )
        .await?;
        add_column(
            manager,
            "drawing_generations",
            "remote_task_id",
            ImageColumnType::String,
        )
        .await?;
        add_column(
            manager,
            "drawing_generations",
            "remote_status",
            ImageColumnType::String,
        )
        .await?;
        add_column(
            manager,
            "drawing_generations",
            "opaque_state_json",
            ImageColumnType::Text,
        )
        .await?;
        add_column(
            manager,
            "drawing_generations",
            "poll_count",
            ImageColumnType::Integer,
        )
        .await?;
        add_column(
            manager,
            "drawing_generations",
            "consecutive_errors",
            ImageColumnType::Integer,
        )
        .await?;
        add_column(
            manager,
            "drawing_generations",
            "last_polled_at",
            ImageColumnType::BigInteger,
        )
        .await?;
        add_column(
            manager,
            "drawing_generations",
            "deadline_at",
            ImageColumnType::BigInteger,
        )
        .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for column in [
            "deadline_at",
            "last_polled_at",
            "consecutive_errors",
            "poll_count",
            "opaque_state_json",
            "remote_status",
            "remote_task_id",
            "adapter_config_snapshot",
            "adapter_id",
        ] {
            drop_column(manager, "drawing_generations", column).await?;
        }
        drop_column(manager, "models", "image_config_json").await
    }
}

async fn add_column(
    manager: &SchemaManager<'_>,
    table: &str,
    column: &str,
    column_type: ImageColumnType,
) -> Result<(), DbErr> {
    let mut definition = ColumnDef::new(Alias::new(column));
    match column_type {
        ImageColumnType::String => definition.string(),
        ImageColumnType::Text => definition.text(),
        ImageColumnType::Integer => definition.integer(),
        ImageColumnType::BigInteger => definition.big_integer(),
    };
    manager
        .alter_table(
            Table::alter()
                .table(Alias::new(table))
                .add_column(definition.null())
                .to_owned(),
        )
        .await
}

enum ImageColumnType {
    String,
    Text,
    Integer,
    BigInteger,
}

async fn drop_column(manager: &SchemaManager<'_>, table: &str, column: &str) -> Result<(), DbErr> {
    manager
        .alter_table(
            Table::alter()
                .table(Alias::new(table))
                .drop_column(Alias::new(column))
                .to_owned(),
        )
        .await
}
