use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"UPDATE providers
               SET provider_type = CASE builtin_id
                   WHEN 'deepseek' THEN 'deepseek'
                   WHEN 'xai' THEN 'xai'
                   WHEN 'glm' THEN 'glm'
                   WHEN 'siliconflow' THEN 'siliconflow'
                   ELSE provider_type
               END
               WHERE builtin_id IN ('deepseek', 'xai', 'glm', 'siliconflow')"#,
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        let db = manager.get_connection();
        db.execute_unprepared(
            r#"UPDATE providers
               SET provider_type = 'openai'
               WHERE builtin_id IN ('deepseek', 'xai', 'glm', 'siliconflow')"#,
        )
        .await?;

        Ok(())
    }
}
