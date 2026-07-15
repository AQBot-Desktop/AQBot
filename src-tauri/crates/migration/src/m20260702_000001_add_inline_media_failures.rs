use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(InlineMediaFailures::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(InlineMediaFailures::MessageId)
                            .string()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(InlineMediaFailures::ContentHash)
                            .string()
                            .not_null(),
                    )
                    .col(ColumnDef::new(InlineMediaFailures::Error).text().not_null())
                    .col(
                        ColumnDef::new(InlineMediaFailures::UpdatedAt)
                            .big_integer()
                            .not_null(),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(InlineMediaFailures::Table, InlineMediaFailures::MessageId)
                            .to(Messages::Table, Messages::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(
                Table::drop()
                    .table(InlineMediaFailures::Table)
                    .if_exists()
                    .to_owned(),
            )
            .await
    }
}

#[derive(DeriveIden)]
enum InlineMediaFailures {
    Table,
    MessageId,
    ContentHash,
    Error,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum Messages {
    Table,
    Id,
}
