use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Create conversation_categories table
        manager
            .create_table(
                Table::create()
                    .table(ConversationCategories::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(ConversationCategories::Id)
                            .string()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(ConversationCategories::Name)
                            .string()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ConversationCategories::IconType)
                            .string()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(ConversationCategories::IconValue)
                            .string()
                            .null(),
                    )
                    .col(
                        ColumnDef::new(ConversationCategories::SortOrder)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(ConversationCategories::IsCollapsed)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(ConversationCategories::CreatedAt)
                            .integer()
                            .not_null(),
                    )
                    .col(
                        ColumnDef::new(ConversationCategories::UpdatedAt)
                            .integer()
                            .not_null(),
                    )
                    .to_owned(),
            )
            .await?;

        // Add category_id column to conversations table
        manager
            .alter_table(
                Table::alter()
                    .table(Conversations::Table)
                    .add_column(ColumnDef::new(Conversations::CategoryId).string().null())
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .alter_table(
                Table::alter()
                    .table(Conversations::Table)
                    .drop_column(Conversations::CategoryId)
                    .to_owned(),
            )
            .await?;

        manager
            .drop_table(
                Table::drop()
                    .table(ConversationCategories::Table)
                    .to_owned(),
            )
            .await?;

        Ok(())
    }
}

#[derive(DeriveIden)]
enum ConversationCategories {
    Table,
    Id,
    Name,
    IconType,
    IconValue,
    SortOrder,
    IsCollapsed,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum Conversations {
    Table,
    CategoryId,
}
