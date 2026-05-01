use sea_orm::sea_query::Expr;
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
        icon_type: m.icon_type,
        icon_value: m.icon_value,
        sort_order: m.sort_order,
        embedding_dimensions: m.embedding_dimensions,
        retrieval_threshold: m.retrieval_threshold,
        retrieval_top_k: m.retrieval_top_k,
        rerank_provider: m.rerank_provider,
        rerank_candidate_k: m.rerank_candidate_k,
        chunk_size: m.chunk_size,
        chunk_overlap: m.chunk_overlap,
        separator: m.separator,
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
        doc_type: m.doc_type,
        index_error: m.index_error,
    }
}

pub async fn list_knowledge_bases(db: &DatabaseConnection) -> Result<Vec<KnowledgeBase>> {
    let models = knowledge_bases::Entity::find()
        .order_by_asc(knowledge_bases::Column::SortOrder)
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
        icon_type: Set(None),
        icon_value: Set(None),
        sort_order: Set(0),
        embedding_dimensions: Set(None),
        retrieval_threshold: Set(None),
        retrieval_top_k: Set(None),
        rerank_provider: Set(None),
        rerank_candidate_k: Set(None),
        chunk_size: Set(None),
        chunk_overlap: Set(None),
        separator: Set(None),
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
    am.enabled = Set(if input.enabled.unwrap_or(existing.enabled) {
        1
    } else {
        0
    });
    if input.update_icon {
        am.icon_type = Set(input.icon_type);
        am.icon_value = Set(input.icon_value);
    }
    if input.update_embedding_dimensions {
        am.embedding_dimensions = Set(input.embedding_dimensions);
    }
    if input.update_retrieval_threshold {
        am.retrieval_threshold = Set(input.retrieval_threshold);
    }
    if input.update_retrieval_top_k {
        am.retrieval_top_k = Set(input.retrieval_top_k);
    }
    if input.update_rerank_provider {
        am.rerank_provider = Set(input.rerank_provider);
    }
    if input.update_rerank_candidate_k {
        am.rerank_candidate_k = Set(input.rerank_candidate_k);
    }
    if input.update_chunk_size {
        am.chunk_size = Set(input.chunk_size);
    }
    if input.update_chunk_overlap {
        am.chunk_overlap = Set(input.chunk_overlap);
    }
    if input.update_separator {
        am.separator = Set(input.separator);
    }
    am.update(db).await?;

    get_knowledge_base(db, id).await
}

pub async fn reorder_knowledge_bases(db: &DatabaseConnection, base_ids: &[String]) -> Result<()> {
    for (i, id) in base_ids.iter().enumerate() {
        knowledge_bases::Entity::update_many()
            .col_expr(knowledge_bases::Column::SortOrder, Expr::value(i as i32))
            .filter(knowledge_bases::Column::Id.eq(id))
            .exec(db)
            .await?;
    }
    Ok(())
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
    doc_type: Option<&str>,
) -> Result<KnowledgeDocument> {
    let id = gen_id();

    // Read actual file size from disk
    let file_size = std::fs::metadata(source_path)
        .map(|m| m.len() as i64)
        .unwrap_or(0);

    let am = knowledge_documents::ActiveModel {
        id: Set(id.clone()),
        knowledge_base_id: Set(knowledge_base_id.to_string()),
        title: Set(title.to_string()),
        source_path: Set(source_path.to_string()),
        mime_type: Set(mime_type.to_string()),
        size_bytes: Set(file_size),
        doc_type: Set(doc_type.unwrap_or("file").to_string()),
        ..Default::default()
    };

    am.insert(db).await?;

    let model = knowledge_documents::Entity::find_by_id(&id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("KnowledgeDocument {}", id)))?;

    Ok(model_to_doc(model))
}

pub async fn update_document_status(db: &DatabaseConnection, id: &str, status: &str) -> Result<()> {
    update_document_status_with_error(db, id, status, None).await
}

pub async fn update_document_status_with_error(
    db: &DatabaseConnection,
    id: &str,
    status: &str,
    error: Option<&str>,
) -> Result<()> {
    let mut am: knowledge_documents::ActiveModel = knowledge_documents::Entity::find_by_id(id)
        .one(db)
        .await?
        .ok_or_else(|| AQBotError::NotFound(format!("KnowledgeDocument {}", id)))?
        .into();

    am.indexing_status = Set(status.to_string());
    am.index_error = Set(error.map(|e| e.to_string()));
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

/// Batch lookup document titles by IDs. Returns a map of document_id -> title.
pub async fn get_document_titles(
    db: &DatabaseConnection,
    doc_ids: &[String],
) -> Result<std::collections::HashMap<String, String>> {
    if doc_ids.is_empty() {
        return Ok(std::collections::HashMap::new());
    }
    let models = knowledge_documents::Entity::find()
        .filter(knowledge_documents::Column::Id.is_in(doc_ids.iter().map(|s| s.as_str())))
        .all(db)
        .await?;
    Ok(models.into_iter().map(|m| (m.id, m.title)).collect())
}
