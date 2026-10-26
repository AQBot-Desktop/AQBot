use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if manager.has_table("roles").await?
            && !manager.has_column("roles", "model_bindings_json").await?
        {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new("roles"))
                        .add_column(
                            ColumnDef::new(Alias::new("model_bindings_json"))
                                .text()
                                .not_null()
                                .default("[]"),
                        )
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        if manager.has_table("roles").await?
            && manager.has_column("roles", "model_bindings_json").await?
        {
            manager
                .alter_table(
                    Table::alter()
                        .table(Alias::new("roles"))
                        .drop_column(Alias::new("model_bindings_json"))
                        .to_owned(),
                )
                .await?;
        }
        Ok(())
    }
}
