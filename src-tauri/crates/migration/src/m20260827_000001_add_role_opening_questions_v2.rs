use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if !manager.has_table("roles").await? {
            return Ok(());
        }
        if manager
            .has_column("roles", "opening_questions_v2_json")
            .await?
        {
            return Ok(());
        }
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("roles"))
                    .add_column(
                        ColumnDef::new(Alias::new("opening_questions_v2_json"))
                            .text()
                            .null(),
                    )
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if !manager.has_table("roles").await? {
            return Ok(());
        }
        if !manager
            .has_column("roles", "opening_questions_v2_json")
            .await?
        {
            return Ok(());
        }
        manager
            .alter_table(
                Table::alter()
                    .table(Alias::new("roles"))
                    .drop_column(Alias::new("opening_questions_v2_json"))
                    .to_owned(),
            )
            .await
    }
}
