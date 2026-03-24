use sea_orm::*;

use crate::entity::{knowledge_bases, knowledge_documents};
use crate::error::{AQBotError, Result};
use crate::types::{
    CreateKnowledgeBaseInput, KnowledgeBase, KnowledgeDocument, UpdateKnowledgeBaseInput,
};
use crate::utils::gen_id;

fn model_to_kb(m: knowledge_bases::Model) -> KnowledgeBase {
    KnowledgeBase {
        id: m.id,
        name: m.name,
        description: m.description,
        embedding_provider: m.embedding_provider,
        enabled: m.enabled != 0,
    }
}

fn model_to_doc(m: knowledge_documents::Model) -> KnowledgeDocument {
    KnowledgeDocument {
        id: m.id,
        knowledge_base_id: m.knowledge_base_id,
        title: m.title,
        source_path: m.source_path,
        mime_type: m.mime_type,
        size_bytes: m.size_bytes,
        indexing_status: m.indexing_status,
    }
}

pub async fn list_knowledge_bases(db: &DatabaseConnection) -> Result<Vec<KnowledgeBase>> {
    let models = knowledge_bases::Entity::find()
        .order_by_asc(knowledge_bases::Column::Name)
        .all(db)
        .await?;

    Ok(models.into_iter().map(model_to_kb).collect())
}

pub async fn get_knowledge_base(db: &DatabaseConnection, id: &str) -> Result<KnowledgeBase> {
    let model = knowledge_bases::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("KnowledgeBase {}", id)))?;

    Ok(model_to_kb(model))
}

pub async fn create_knowledge_base(
    db: &DatabaseConnection,
    input: CreateKnowledgeBaseInput,
) -> Result<KnowledgeBase> {
    let id = gen_id();

    let am = knowledge_bases::ActiveModel {
        id: Set(id.clone()),
        name: Set(input.name),
        description: Set(input.description),
        embedding_provider: Set(input.embedding_provider),
        enabled: Set(if input.enabled.unwrap_or(true) { 1 } else { 0 }),
    };

    am.insert(db).await?;

    get_knowledge_base(db, &id).await
}

pub async fn update_knowledge_base(
    db: &DatabaseConnection,
    id: &str,
    input: UpdateKnowledgeBaseInput,
) -> Result<KnowledgeBase> {
    let model = knowledge_bases::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("KnowledgeBase {}", id)))?;

    let existing = model_to_kb(model.clone());

    let mut am: knowledge_bases::ActiveModel = model.into();
    am.name = Set(input.name.unwrap_or(existing.name));
    am.description = Set(input.description.or(existing.description));
    am.embedding_provider = Set(input.embedding_provider.or(existing.embedding_provider));
    am.enabled = Set(if input.enabled.unwrap_or(existing.enabled) { 1 } else { 0 });
    am.update(db).await?;

    get_knowledge_base(db, id).await
}

pub async fn delete_knowledge_base(db: &DatabaseConnection, id: &str) -> Result<()> {
    let result = knowledge_bases::Entity::delete_by_id(id).exec(db).await?;

    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("KnowledgeBase {}", id)));
    }
    Ok(())
}

pub async fn list_documents(
    db: &DatabaseConnection,
    base_id: &str,
) -> Result<Vec<KnowledgeDocument>> {
    let models = knowledge_documents::Entity::find()
        .filter(knowledge_documents::Column::KnowledgeBaseId.eq(base_id))
        .order_by_asc(knowledge_documents::Column::Title)
        .all(db)
        .await?;

    Ok(models.into_iter().map(model_to_doc).collect())
}

pub async fn add_document(
    db: &DatabaseConnection,
    knowledge_base_id: &str,
    title: &str,
    source_path: &str,
    mime_type: &str,
) -> Result<KnowledgeDocument> {
    let id = gen_id();

    let am = knowledge_documents::ActiveModel {
        id: Set(id.clone()),
        knowledge_base_id: Set(knowledge_base_id.to_string()),
        title: Set(title.to_string()),
        source_path: Set(source_path.to_string()),
        mime_type: Set(mime_type.to_string()),
        ..Default::default()
    };

    am.insert(db).await?;

    let model = knowledge_documents::Entity::find_by_id(&id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("KnowledgeDocument {}", id)))?;

    Ok(model_to_doc(model))
}

pub async fn update_document_status(
    db: &DatabaseConnection,
    id: &str,
    status: &str,
) -> Result<()> {
    let mut am: knowledge_documents::ActiveModel = knowledge_documents::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("KnowledgeDocument {}", id)))?
        .into();

    am.indexing_status = Set(status.to_string());
    am.update(db).await?;
    Ok(())
}

pub async fn delete_document(db: &DatabaseConnection, id: &str) -> Result<()> {
    let result = knowledge_documents::Entity::delete_by_id(id)
        .exec(db)
        .await?;

    if result.rows_affected == 0 {
        return Err(AQBotError::NotFound(format!("KnowledgeDocument {}", id)));
    }
    Ok(())
}
