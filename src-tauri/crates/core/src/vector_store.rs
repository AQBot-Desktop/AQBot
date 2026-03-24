use std::path::Path;
use std::sync::Arc;

use arrow_array::{
    ArrayRef, FixedSizeListArray, Float32Array, Int32Array, RecordBatch,
    RecordBatchIterator, StringArray,
};
use arrow_schema::{DataType, Field, Schema, SchemaRef};
use futures::TryStreamExt;
use lancedb::connect;
use lancedb::query::{ExecutableQuery, QueryBase};

use crate::error::{AQBotError, Result};

/// A single embedding record for storage in the vector database.
#[derive(Debug, Clone)]
pub struct EmbeddingRecord {
    /// Unique chunk identifier
    pub id: String,
    /// Parent document identifier
    pub document_id: String,
    /// Position of this chunk within the document
    pub chunk_index: i32,
    /// Text content of the chunk
    pub content: String,
    /// Embedding vector
    pub embedding: Vec<f32>,
}

/// A result returned from vector similarity search.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct VectorSearchResult {
    pub id: String,
    pub document_id: String,
    pub chunk_index: i32,
    pub content: String,
    /// Distance score (lower is more similar for L2 distance)
    pub score: f32,
}

/// LanceDB-backed vector store for knowledge base embeddings.
///
/// Each knowledge base gets its own LanceDB table, named `kb_<id>`.
/// Vector data is stored at `<data_dir>/vector_db/`.
pub struct VectorStore {
    db: lancedb::Connection,
}

impl VectorStore {
    /// Open (or create) a VectorStore rooted at `data_dir`.
    ///
    /// The LanceDB files will be stored under `data_dir/vector_db/`.
    pub async fn new(data_dir: &Path) -> Result<Self> {
        let db_path = data_dir.join("vector_db");
        std::fs::create_dir_all(&db_path)?;

        let db = connect(&db_path.to_string_lossy())
            .execute()
            .await
            .map_err(|e| AQBotError::Provider(format!("LanceDB connection failed: {e}")))?;

        Ok(Self { db })
    }

    /// Arrow schema used for embedding tables with given dimensions.
    fn embedding_schema(dimensions: usize) -> SchemaRef {
        Arc::new(Schema::new(vec![
            Field::new("id", DataType::Utf8, false),
            Field::new("document_id", DataType::Utf8, false),
            Field::new("chunk_index", DataType::Int32, false),
            Field::new("content", DataType::Utf8, false),
            Field::new(
                "vector",
                DataType::FixedSizeList(
                    Arc::new(Field::new("item", DataType::Float32, true)),
                    dimensions as i32,
                ),
                false,
            ),
        ]))
    }

    /// Derive the LanceDB table name for a knowledge base.
    fn collection_name(collection_id: &str) -> String {
        collection_id.replace('-', "_")
    }

    /// Ensure a LanceDB table exists for the given knowledge base,
    /// creating an empty one if it does not.
    pub async fn ensure_collection(&self, collection_id: &str, dimensions: usize) -> Result<()> {
        let name = Self::collection_name(collection_id);

        let tables = self
            .db
            .table_names()
            .execute()
            .await
            .map_err(|e| AQBotError::Provider(format!("Failed to list tables: {e}")))?;

        if !tables.contains(&name) {
            let schema = Self::embedding_schema(dimensions);
            self.db
                .create_empty_table(&name, schema)
                .execute()
                .await
                .map_err(|e| AQBotError::Provider(format!("Failed to create table: {e}")))?;
        }

        Ok(())
    }

    /// Upsert embedding records for a single document.
    ///
    /// All existing embeddings for the document (identified by `document_id` of
    /// the first record) are deleted before the new records are inserted.
    pub async fn upsert_embeddings(
        &self,
        collection_id: &str,
        records: Vec<EmbeddingRecord>,
    ) -> Result<()> {
        if records.is_empty() {
            return Ok(());
        }

        let dimensions = records[0].embedding.len();

        // Validate all records have consistent dimensions
        for (i, record) in records.iter().enumerate() {
            if record.embedding.len() != dimensions {
                return Err(AQBotError::Provider(format!(
                    "Embedding dimension mismatch at record {}: got {} but expected {}",
                    i, record.embedding.len(), dimensions
                )));
            }
        }

        self.ensure_collection(collection_id, dimensions).await?;

        let name = Self::collection_name(collection_id);
        let table = self
            .db
            .open_table(&name)
            .execute()
            .await
            .map_err(|e| AQBotError::Provider(format!("Failed to open table: {e}")))?;

        // Remove previous embeddings for this document before inserting.
        let doc_id = &records[0].document_id;
        let _ = table
            .delete(&format!("document_id = '{doc_id}'"))
            .await;

        let batch = Self::records_to_batch(dimensions, &records)?;
        let schema = Self::embedding_schema(dimensions);
        let batches = RecordBatchIterator::new(vec![Ok(batch)], schema);

        table
            .add(Box::new(batches))
            .execute()
            .await
            .map_err(|e| AQBotError::Provider(format!("Failed to add embeddings: {e}")))?;

        Ok(())
    }

    /// Search for the most similar vectors in a knowledge base.
    ///
    /// Returns up to `top_k` results ordered by ascending distance.
    /// If the collection does not exist yet, an empty vec is returned.
    pub async fn search(
        &self,
        knowledge_base_id: &str,
        query_embedding: Vec<f32>,
        top_k: usize,
    ) -> Result<Vec<VectorSearchResult>> {
        let name = Self::collection_name(knowledge_base_id);

        let tables = self
            .db
            .table_names()
            .execute()
            .await
            .map_err(|e| AQBotError::Provider(format!("Failed to list tables: {e}")))?;

        if !tables.contains(&name) {
            return Ok(vec![]);
        }

        let table = self
            .db
            .open_table(&name)
            .execute()
            .await
            .map_err(|e| AQBotError::Provider(format!("Failed to open table: {e}")))?;

        let batches = table
            .query()
            .nearest_to(query_embedding)
            .map_err(|e| AQBotError::Provider(format!("Search setup failed: {e}")))?
            .limit(top_k)
            .execute()
            .await
            .map_err(|e| AQBotError::Provider(format!("Search execution failed: {e}")))?
            .try_collect::<Vec<RecordBatch>>()
            .await
            .map_err(|e| AQBotError::Provider(format!("Failed to collect results: {e}")))?;

        let mut results = Vec::new();
        for batch in &batches {
            self.extract_search_results(batch, &mut results);
        }

        Ok(results)
    }

    /// Delete all embeddings belonging to a specific document.
    pub async fn delete_document_embeddings(
        &self,
        knowledge_base_id: &str,
        document_id: &str,
    ) -> Result<()> {
        let name = Self::collection_name(knowledge_base_id);

        let tables = self
            .db
            .table_names()
            .execute()
            .await
            .map_err(|e| AQBotError::Provider(format!("Failed to list tables: {e}")))?;

        if tables.contains(&name) {
            let table = self
                .db
                .open_table(&name)
                .execute()
                .await
                .map_err(|e| AQBotError::Provider(format!("Failed to open table: {e}")))?;

            table
                .delete(&format!("document_id = '{document_id}'"))
                .await
                .map_err(|e| AQBotError::Provider(format!("Failed to delete embeddings: {e}")))?;
        }

        Ok(())
    }

    /// Drop the entire LanceDB table for a knowledge base.
    ///
    /// Silently succeeds if the table does not exist.
    pub async fn delete_collection(&self, knowledge_base_id: &str) -> Result<()> {
        let name = Self::collection_name(knowledge_base_id);
        let _ = self.db.drop_table(&name).await;
        Ok(())
    }

    // ── private helpers ─────────────────────────────────────────────────

    /// Convert a slice of [`EmbeddingRecord`]s into an Arrow [`RecordBatch`].
    fn records_to_batch(dimensions: usize, records: &[EmbeddingRecord]) -> Result<RecordBatch> {
        let schema = Self::embedding_schema(dimensions);

        let ids: Vec<&str> = records.iter().map(|r| r.id.as_str()).collect();
        let doc_ids: Vec<&str> = records.iter().map(|r| r.document_id.as_str()).collect();
        let chunk_indices: Vec<i32> = records.iter().map(|r| r.chunk_index).collect();
        let contents: Vec<&str> = records.iter().map(|r| r.content.as_str()).collect();

        let flat_embeddings: Vec<f32> = records
            .iter()
            .flat_map(|r| r.embedding.iter().copied())
            .collect();

        let id_array = Arc::new(StringArray::from(ids)) as ArrayRef;
        let doc_id_array = Arc::new(StringArray::from(doc_ids)) as ArrayRef;
        let chunk_index_array = Arc::new(Int32Array::from(chunk_indices)) as ArrayRef;
        let content_array = Arc::new(StringArray::from(contents)) as ArrayRef;

        let float_array = Arc::new(Float32Array::from(flat_embeddings)) as ArrayRef;
        let field = Arc::new(Field::new("item", DataType::Float32, true));
        let vector_array = Arc::new(
            FixedSizeListArray::new(field, dimensions as i32, float_array, None),
        ) as ArrayRef;

        RecordBatch::try_new(
            schema,
            vec![
                id_array,
                doc_id_array,
                chunk_index_array,
                content_array,
                vector_array,
            ],
        )
        .map_err(|e| AQBotError::Provider(format!("Failed to create record batch: {e}")))
    }

    /// Extract [`VectorSearchResult`]s from a single Arrow [`RecordBatch`]
    /// returned by a LanceDB nearest-neighbour query.
    fn extract_search_results(&self, batch: &RecordBatch, out: &mut Vec<VectorSearchResult>) {
        let id_col = batch
            .column_by_name("id")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>());
        let doc_id_col = batch
            .column_by_name("document_id")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>());
        let chunk_col = batch
            .column_by_name("chunk_index")
            .and_then(|c| c.as_any().downcast_ref::<Int32Array>());
        let content_col = batch
            .column_by_name("content")
            .and_then(|c| c.as_any().downcast_ref::<StringArray>());
        let score_col = batch
            .column_by_name("_distance")
            .and_then(|c| c.as_any().downcast_ref::<Float32Array>());

        if let (Some(ids), Some(doc_ids), Some(chunks), Some(contents), Some(scores)) =
            (id_col, doc_id_col, chunk_col, content_col, score_col)
        {
            for i in 0..batch.num_rows() {
                out.push(VectorSearchResult {
                    id: ids.value(i).to_string(),
                    document_id: doc_ids.value(i).to_string(),
                    chunk_index: chunks.value(i),
                    content: contents.value(i).to_string(),
                    score: scores.value(i),
                });
            }
        }
    }
}
