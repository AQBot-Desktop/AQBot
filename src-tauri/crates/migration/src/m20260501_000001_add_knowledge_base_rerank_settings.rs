use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(KnowledgeBases::Table)
                    .add_column(
                        ColumnDef::new(KnowledgeBases::RerankProvider)
                            .string()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(KnowledgeBases::Table)
                    .add_column(
                        ColumnDef::new(KnowledgeBases::RerankCandidateK)
                            .integer()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, _manager: &SchemaManager) -> Result<(), DbErr> {
        Ok(())
    }
}

#[derive(DeriveIden)]
enum KnowledgeBases {
    Table,
    RerankProvider,
    RerankCandidateK,
}
