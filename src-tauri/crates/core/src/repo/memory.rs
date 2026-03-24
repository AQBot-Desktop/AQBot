use sea_orm::*;

use crate::entity::{memory_items, memory_namespaces};
use crate::error::{AQBotError, Result};
use crate::types::{CreateMemoryItemInput, CreateMemoryNamespaceInput, MemoryItem, MemoryNamespace, UpdateMemoryNamespaceInput};
use crate::utils::gen_id;

fn model_to_namespace(m: memory_namespaces::Model) -> MemoryNamespace {
    MemoryNamespace {
        id: m.id,
        name: m.name,
        scope: m.scope,
        embedding_provider: m.embedding_provider,
    }
}

fn model_to_item(m: memory_items::Model) -> MemoryItem {
    MemoryItem {
        id: m.id,
        namespace_id: m.namespace_id,
        title: m.title,
        content: m.content,
        source: m.source,
        updated_at: m.updated_at,
    }
}

pub async fn list_namespaces(db: &DatabaseConnection) -> Result<Vec<MemoryNamespace>> {
    let models = memory_namespaces::Entity::find()
        .order_by_asc(memory_namespaces::Column::Name)
        .all(db)
        .await?;

    Ok(models.into_iter().map(model_to_namespace).collect())
}

pub async fn get_namespace(db: &DatabaseConnection, id: &str) -> Result<MemoryNamespace> {
    let model = memory_namespaces::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("MemoryNamespace {}", id)))?;

    Ok(model_to_namespace(model))
}

pub async fn create_namespace(
    db: &DatabaseConnection,
    input: CreateMemoryNamespaceInput,
) -> Result<MemoryNamespace> {
    let id = gen_id();

    let am = memory_namespaces::ActiveModel {
        id: Set(id.clone()),
        name: Set(input.name),
        scope: Set(input.scope),
        embedding_provider: Set(input.embedding_provider),
    };

    am.insert(db).await?;

    get_namespace(db, &id).await
}

pub async fn delete_namespace(db: &DatabaseConnection, id: &str) -> Result<()> {
    let result = memory_namespaces::Entity::delete_by_id(id)
        .exec(db)
        .await?;

    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("MemoryNamespace {}", id)));
    }
    Ok(())
}

pub async fn update_namespace(
    db: &DatabaseConnection,
    id: &str,
    input: UpdateMemoryNamespaceInput,
) -> Result<MemoryNamespace> {
    let model = memory_namespaces::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("MemoryNamespace {}", id)))?;

    let mut am: memory_namespaces::ActiveModel = model.clone().into();
    if let Some(name) = input.name {
        am.name = Set(name);
    }
    am.embedding_provider = Set(input.embedding_provider);
    am.update(db).await?;

    get_namespace(db, id).await
}

pub async fn list_items(db: &DatabaseConnection, namespace_id: &str) -> Result<Vec<MemoryItem>> {
    let models = memory_items::Entity::find()
        .filter(memory_items::Column::NamespaceId.eq(namespace_id))
        .order_by_desc(memory_items::Column::UpdatedAt)
        .all(db)
        .await?;

    Ok(models.into_iter().map(model_to_item).collect())
}

pub async fn add_item(db: &DatabaseConnection, input: CreateMemoryItemInput) -> Result<MemoryItem> {
    let id = gen_id();
    let source = input.source.unwrap_or_else(|| "manual".to_string());

    let am = memory_items::ActiveModel {
        id: Set(id.clone()),
        namespace_id: Set(input.namespace_id),
        title: Set(input.title),
        content: Set(input.content),
        source: Set(source),
        ..Default::default()
    };

    am.insert(db).await?;

    let model = memory_items::Entity::find_by_id(&id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("MemoryItem {}", id)))?;

    Ok(model_to_item(model))
}

pub async fn delete_item(db: &DatabaseConnection, id: &str) -> Result<()> {
    let result = memory_items::Entity::delete_by_id(id).exec(db).await?;

    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("MemoryItem {}", id)));
    }
    Ok(())
}
