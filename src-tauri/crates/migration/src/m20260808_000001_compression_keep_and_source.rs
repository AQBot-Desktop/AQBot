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
                        ColumnDef::new(Alias::new("compression_keep_last_n"))
                            .integer()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("conversation_summaries"))
                    .add_column(ColumnDef::new(Alias::new("source_text")).text().null())
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("conversation_summaries"))
                    .drop_column(Alias::new("source_text"))
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("conversations"))
                    .drop_column(Alias::new("compression_keep_last_n"))
                    .to_owned(),
            )
            .await?;

        Ok(())
    }
}
