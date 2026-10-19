use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // 1. conversations.mode
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("conversations"))
                    .add_column(
                        ColumnDef::new(Alias::new("mode"))
                            .string()
                            .not_null()
                            .default("chat"),
                    )
                    .to_owned(),
            )
            .await?;

        // 2. tool_executions.approval_status
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("tool_executions"))
                    .add_column(
                        ColumnDef::new(Alias::new("approval_status"))
                            .string()
                            .null(),
                    )
                    .to_owned(),
            )
            .await?;

        // 3. agent_sessions table
        manager
            .create_table(
                Table::create()
                    .table(Alias::new("agent_sessions"))
                    .if_not_exists()
                    .col(
                        ColumnDef::new(Alias::new("id"))
                            .string()
                            .not_null()
                            .primary_key(),
                    )
                    .col(
                        ColumnDef::new(Alias::new("conversation_id"))
                            .string()
                            .not_null(),
                    )
                    .col(ColumnDef::new(Alias::new("cwd")).string().null())
                    .col(
                        ColumnDef::new(Alias::new("permission_mode"))
                            .string()
                            .not_null()
                            .default("default"),
                    )
                    .col(
                        ColumnDef::new(Alias::new("runtime_status"))
                            .string()
                            .not_null()
                            .default("idle"),
                    )
                    .col(ColumnDef::new(Alias::new("sdk_context_json")).text().null())
                    .col(
                        ColumnDef::new(Alias::new("total_tokens"))
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(Alias::new("total_cost_usd"))
                            .double()
                            .not_null()
                            .default(0.0),
                    )
                    .col(ColumnDef::new(Alias::new("created_at")).string().not_null())
                    .col(ColumnDef::new(Alias::new("updated_at")).string().not_null())
                    .to_owned(),
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Alias::new("agent_sessions")).to_owned())
            .await?;
        // SQLite doesn't support DROP COLUMN, so we skip reverting alter_table
        Ok(())
    }
}
