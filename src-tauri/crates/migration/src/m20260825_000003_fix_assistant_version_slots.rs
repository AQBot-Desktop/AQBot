use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared(
                "UPDATE messages
                 SET version_index = ranked.new_index
                 FROM (
                     SELECT id,
                            ROW_NUMBER() OVER (
                                PARTITION BY conversation_id, parent_message_id
                                ORDER BY version_index ASC, created_at ASC, id ASC
                            ) - 1 AS new_index
                     FROM messages
                     WHERE role = 'assistant'
                       AND parent_message_id IS NOT NULL
                       AND version_index >= 0
                 ) AS ranked
                 WHERE messages.id = ranked.id
                   AND messages.version_index != ranked.new_index",
            )
            .await?;

        manager
            .get_connection()
            .execute_unprepared(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_assistant_version_slot
                 ON messages (conversation_id, parent_message_id, version_index)
                 WHERE role = 'assistant'
                   AND parent_message_id IS NOT NULL
                   AND version_index >= 0",
            )
            .await?;
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP INDEX IF EXISTS idx_messages_assistant_version_slot")
            .await?;
        Ok(())
    }
}
