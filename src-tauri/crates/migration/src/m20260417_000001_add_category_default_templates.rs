use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for alter in [
            Table::alter()
                .table(ConversationCategories::Table)
                .add_column(
                    ColumnDef::new(ConversationCategories::DefaultProviderId)
                        .string()
                        .null(),
                )
                .to_owned(),
            Table::alter()
                .table(ConversationCategories::Table)
                .add_column(
                    ColumnDef::new(ConversationCategories::DefaultModelId)
                        .string()
                        .null(),
                )
                .to_owned(),
            Table::alter()
                .table(ConversationCategories::Table)
                .add_column(
                    ColumnDef::new(ConversationCategories::DefaultTemperature)
                        .double()
                        .null(),
                )
                .to_owned(),
            Table::alter()
                .table(ConversationCategories::Table)
                .add_column(
                    ColumnDef::new(ConversationCategories::DefaultMaxTokens)
                        .big_integer()
                        .null(),
                )
                .to_owned(),
            Table::alter()
                .table(ConversationCategories::Table)
                .add_column(
                    ColumnDef::new(ConversationCategories::DefaultTopP)
                        .double()
                        .null(),
                )
                .to_owned(),
            Table::alter()
                .table(ConversationCategories::Table)
                .add_column(
                    ColumnDef::new(ConversationCategories::DefaultFrequencyPenalty)
                        .double()
                        .null(),
                )
                .to_owned(),
        ] {
            manager.alter_table(alter).await?;
        }

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for alter in [
            Table::alter()
                .table(ConversationCategories::Table)
                .drop_column(ConversationCategories::DefaultFrequencyPenalty)
                .to_owned(),
            Table::alter()
                .table(ConversationCategories::Table)
                .drop_column(ConversationCategories::DefaultTopP)
                .to_owned(),
            Table::alter()
                .table(ConversationCategories::Table)
                .drop_column(ConversationCategories::DefaultMaxTokens)
                .to_owned(),
            Table::alter()
                .table(ConversationCategories::Table)
                .drop_column(ConversationCategories::DefaultTemperature)
                .to_owned(),
            Table::alter()
                .table(ConversationCategories::Table)
                .drop_column(ConversationCategories::DefaultModelId)
                .to_owned(),
            Table::alter()
                .table(ConversationCategories::Table)
                .drop_column(ConversationCategories::DefaultProviderId)
                .to_owned(),
        ] {
            manager.alter_table(alter).await?;
        }

        Ok(())
    }
}

#[derive(DeriveIden)]
enum ConversationCategories {
    Table,
    DefaultProviderId,
    DefaultModelId,
    DefaultTemperature,
    DefaultMaxTokens,
    DefaultTopP,
    DefaultFrequencyPenalty,
}
