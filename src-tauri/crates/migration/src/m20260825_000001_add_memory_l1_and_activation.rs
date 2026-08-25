use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Alias::new("memory_l1"))
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Alias::new("id"))
                            .text()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(Alias::new("enabled"))
                            .integer()
                            .not_null()
                            .default(1),
                    )
                    .col(
                        ColumnDef::new(Alias::new("markdown"))
                            .text()
                            .not_null()
                            .default(""),
                    )
                    .col(
                        ColumnDef::new(Alias::new("revision"))
                            .big_integer()
                            .not_null()
                            .default(0),
                    )
                    .col(ColumnDef::new(Alias::new("updated_at")).text().not_null())
                    .to_owned(),
            )
            .await?;

        manager
            .get_connection()
            .execute_unprepared(
                "INSERT INTO memory_l1 (id, enabled, markdown, revision, updated_at)
                 SELECT 'global', 1, '', 0, datetime('now')
                 WHERE NOT EXISTS (SELECT 1 FROM memory_l1 WHERE id = 'global')",
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("memory_namespaces"))
                    .add_column(
                        ColumnDef::new(Alias::new("activation_mode"))
                            .text()
                            .not_null()
                            .default("tool_only"),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("memory_namespaces"))
                    .add_column(
                        ColumnDef::new(Alias::new("migration_review_required"))
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .get_connection()
            .execute_unprepared(
                "UPDATE memory_namespaces
                 SET activation_mode = 'auto', migration_review_required = 0
                 WHERE embedding_provider IS NOT NULL
                   AND trim(embedding_provider) != ''",
            )
            .await?;

        manager
            .get_connection()
            .execute_unprepared(
                "UPDATE memory_namespaces
                 SET activation_mode = 'tool_only', migration_review_required = 1
                 WHERE embedding_provider IS NULL
                    OR trim(embedding_provider) = ''",
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("memory_namespaces"))
                    .drop_column(Alias::new("migration_review_required"))
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("memory_namespaces"))
                    .drop_column(Alias::new("activation_mode"))
                    .to_owned(),
            )
            .await?;
        manager
            .drop_table(Table::drop().table(Alias::new("memory_l1")).to_owned())
            .await
    }
}
