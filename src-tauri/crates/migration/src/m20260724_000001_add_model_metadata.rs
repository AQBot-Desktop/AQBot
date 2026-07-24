use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        add_column(manager, "max_output_tokens", ColumnKind::BigInteger).await?;
        add_column(manager, "metadata_state_json", ColumnKind::Text).await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        drop_column(manager, "metadata_state_json").await?;
        drop_column(manager, "max_output_tokens").await
    }
}

async fn add_column(
    manager: &SchemaManager<'_>,
    name: &str,
    kind: ColumnKind,
) -> Result<(), DbErr> {
    let mut definition = ColumnDef::new(Alias::new(name));
    match kind {
        ColumnKind::BigInteger => definition.big_integer(),
        ColumnKind::Text => definition.text(),
    };
    manager
        .alter_table(
            Table::alter()
                .table(Alias::new("models"))
                .add_column(definition.null())
                .to_owned(),
        )
        .await
}

async fn drop_column(manager: &SchemaManager<'_>, name: &str) -> Result<(), DbErr> {
    manager
        .alter_table(
            Table::alter()
                .table(Alias::new("models"))
                .drop_column(Alias::new(name))
                .to_owned(),
        )
        .await
}

enum ColumnKind {
    BigInteger,
    Text,
}
