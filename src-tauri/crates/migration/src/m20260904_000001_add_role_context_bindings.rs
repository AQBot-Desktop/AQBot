use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if manager.has_table("roles").await? {
            add_column_if_missing(manager, "enabled_knowledge_base_ids_json").await?;
            add_column_if_missing(manager, "enabled_memory_namespace_ids_json").await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if manager.has_table("roles").await? {
            drop_column_if_exists(manager, "enabled_knowledge_base_ids_json").await?;
            drop_column_if_exists(manager, "enabled_memory_namespace_ids_json").await?;
        }
        Ok(())
    }
}

async fn add_column_if_missing(manager: &SchemaManager<'_>, name: &str) -> Result<(), DbErr> {
    if manager.has_column("roles", name).await? {
        return Ok(());
    }
    manager
        .alter_table(
            Table::alter()
                .table(Alias::new("roles"))
                .add_column(
                    ColumnDef::new(Alias::new(name))
                        .text()
                        .not_null()
                        .default("[]"),
                )
                .to_owned(),
        )
        .await
}

async fn drop_column_if_exists(manager: &SchemaManager<'_>, name: &str) -> Result<(), DbErr> {
    if !manager.has_column("roles", name).await? {
        return Ok(());
    }
    manager
        .alter_table(
            Table::alter()
                .table(Alias::new("roles"))
                .drop_column(Alias::new(name))
                .to_owned(),
        )
        .await
}
