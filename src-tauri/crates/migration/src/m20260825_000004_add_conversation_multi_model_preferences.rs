use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("conversations"))
                    .add_column(
                        ColumnDef::new(Alias::new("multi_model_targets_json"))
                            .text()
                            .not_null()
                            .default("[]"),
                    )
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("conversations"))
                    .add_column(
                        ColumnDef::new(Alias::new("multi_model_continuation_mode"))
                            .text()
                            .not_null()
                            .default("selected"),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("conversations"))
                    .drop_column(Alias::new("multi_model_continuation_mode"))
                    .to_owned(),
            )
            .await?;
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("conversations"))
                    .drop_column(Alias::new("multi_model_targets_json"))
                    .to_owned(),
            )
            .await
    }
}
