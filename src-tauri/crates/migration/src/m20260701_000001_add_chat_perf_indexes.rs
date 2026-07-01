use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_index(
                Index::create()
                    .name("idx_messages_conv_active_created_id")
                    .table(Messages::Table)
                    .col(Messages::ConversationId)
                    .col(Messages::IsActive)
                    .col(Messages::CreatedAt)
                    .col(Messages::Id)
                    .if_not_exists()
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_messages_conv_parent_role_version")
                    .table(Messages::Table)
                    .col(Messages::ConversationId)
                    .col(Messages::ParentMessageId)
                    .col(Messages::Role)
                    .col(Messages::VersionIndex)
                    .if_not_exists()
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_messages_conv_role_parent")
                    .table(Messages::Table)
                    .col(Messages::ConversationId)
                    .col(Messages::Role)
                    .col(Messages::ParentMessageId)
                    .if_not_exists()
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_messages_conv_created_id")
                    .table(Messages::Table)
                    .col(Messages::ConversationId)
                    .col(Messages::CreatedAt)
                    .col(Messages::Id)
                    .if_not_exists()
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_conversations_active_order")
                    .table(Conversations::Table)
                    .col(Conversations::IsArchived)
                    .col(Conversations::IsPinned)
                    .col(Conversations::UpdatedAt)
                    .if_not_exists()
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_conversations_archived_order")
                    .table(Conversations::Table)
                    .col(Conversations::IsArchived)
                    .col(Conversations::UpdatedAt)
                    .if_not_exists()
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        for name in [
            "idx_conversations_archived_order",
            "idx_conversations_active_order",
            "idx_messages_conv_created_id",
            "idx_messages_conv_role_parent",
            "idx_messages_conv_parent_role_version",
            "idx_messages_conv_active_created_id",
        ] {
            manager
                .drop_index(Index::drop().name(name).if_exists().to_owned())
                .await?;
        }
        Ok(())
    }
}

#[derive(DeriveIden)]
enum Messages {
    Table,
    ConversationId,
    IsActive,
    ParentMessageId,
    Role,
    VersionIndex,
    CreatedAt,
    Id,
}

#[derive(DeriveIden)]
enum Conversations {
    Table,
    IsArchived,
    IsPinned,
    UpdatedAt,
}
