use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, DbErr, Statement};

use crate::error::{AQBotError, Result};

/// Register the sqlite-vec extension globally.
///
/// Must be called **once** before any SQLite connection is opened.
pub fn register_sqlite_vec_extension() {
    unsafe {
        libsqlite3_sys::sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    }
}

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
    #[serde(
        default,
        rename = "rerankScore",
        skip_serializing_if = "Option::is_none"
    )]
    pub rerank_score: Option<f32>,
    /// Whether this chunk has an embedding in vec0
    pub has_embedding: bool,
}

/// sqlite-vec–backed vector store for knowledge base embeddings.
///
/// Each knowledge base gets two tables in the shared SQLite database:
/// - `vec_{id}_meta` — chunk metadata (id, document_id, content, …)
/// - `vec_{id}`      — vec0 virtual table holding the embedding vectors
pub struct VectorStore {
    db: DatabaseConnection,
}

impl VectorStore {
    /// Create a VectorStore that uses an existing sea-orm connection.
    pub fn new(db: DatabaseConnection) -> Self {
        Self { db }
    }

    /// Sanitised table-name prefix for a collection.
    fn collection_name(collection_id: &str) -> String {
        format!("vec_{}", collection_id.replace('-', "_"))
    }

    /// Ensure both the metadata and vec0 tables exist for a collection.
    pub async fn ensure_collection(&self, collection_id: &str, dimensions: usize) -> Result<()> {
        let name = Self::collection_name(collection_id);

        self.exec(&format!(
            "CREATE TABLE IF NOT EXISTS {name}_meta (
                rowid INTEGER PRIMARY KEY AUTOINCREMENT,
                id TEXT NOT NULL UNIQUE,
                document_id TEXT NOT NULL,
                chunk_index INTEGER NOT NULL,
                content TEXT NOT NULL
            )"
        ))
        .await?;

        self.exec(&format!(
            "CREATE INDEX IF NOT EXISTS idx_{name}_doc ON {name}_meta(document_id)"
        ))
        .await?;

        self.exec(&format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS {name} USING vec0(embedding float[{dimensions}])"
        ))
        .await?;

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

        for (i, record) in records.iter().enumerate() {
            if record.embedding.len() != dimensions {
                return Err(AQBotError::Provider(format!(
                    "Embedding dimension mismatch at record {}: got {} but expected {}",
                    i,
                    record.embedding.len(),
                    dimensions
                )));
            }
        }

        self.ensure_collection(collection_id, dimensions).await?;

        let name = Self::collection_name(collection_id);
        let doc_id = &records[0].document_id;

        // Delete previous embeddings for this document.
        self.delete_rows_by_document(&name, doc_id).await?;

        // Determine the next safe rowid to avoid UNIQUE conflicts.
        // We must check both _meta AND vec0 tables because orphan rows
        // can exist in vec0 after a previous crash/panic mid-insert.
        let meta_max = self
            .db
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                format!("SELECT COALESCE(MAX(rowid), 0) AS max_rid FROM {name}_meta"),
            ))
            .await
            .map_err(Self::wrap)?
            .and_then(|r| r.try_get::<i64>("", "max_rid").ok())
            .unwrap_or(0);

        let vec_max = self
            .db
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                format!("SELECT COALESCE(MAX(rowid), 0) AS max_rid FROM {name}"),
            ))
            .await
            .ok()
            .flatten()
            .and_then(|r| r.try_get::<i64>("", "max_rid").ok())
            .unwrap_or(0);

        let mut next_rowid: i64 = meta_max.max(vec_max) + 1;

        // Insert new records with explicit correlated rowids.
        for record in &records {
            let vec_json = Self::embedding_to_json(&record.embedding);
            let rid = next_rowid;
            next_rowid += 1;

            // Insert embedding into vec0 with explicit rowid
            self.db
                .execute(Statement::from_sql_and_values(
                    DbBackend::Sqlite,
                    &format!("INSERT INTO {name} (rowid, embedding) VALUES ($1, $2)"),
                    vec![rid.into(), vec_json.into()],
                ))
                .await
                .map_err(Self::wrap)?;

            // Insert meta with the same rowid
            self.db
                .execute(Statement::from_sql_and_values(
                    DbBackend::Sqlite,
                    &format!(
                        "INSERT INTO {name}_meta (rowid, id, document_id, chunk_index, content) \
                         VALUES ($1, $2, $3, $4, $5)"
                    ),
                    vec![
                        rid.into(),
                        record.id.clone().into(),
                        record.document_id.clone().into(),
                        record.chunk_index.into(),
                        record.content.clone().into(),
                    ],
                ))
                .await
                .map_err(Self::wrap)?;
        }

        Ok(())
    }

    /// Add a single chunk to an existing collection.
    /// Returns the generated chunk ID.
    pub async fn add_single_chunk(
        &self,
        collection_id: &str,
        document_id: &str,
        content: &str,
        embedding: &[f32],
    ) -> Result<String> {
        let name = Self::collection_name(collection_id);
        let meta_table = format!("{name}_meta");

        if !self.table_exists(&meta_table).await? {
            return Err(AQBotError::NotFound("Collection not found".into()));
        }

        // Determine next chunk_index for this document
        let max_index = self
            .db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                &format!("SELECT COALESCE(MAX(chunk_index), -1) AS max_idx FROM {meta_table} WHERE document_id = $1"),
                vec![document_id.to_string().into()],
            ))
            .await
            .map_err(Self::wrap)?
            .and_then(|r| r.try_get::<i32>("", "max_idx").ok())
            .unwrap_or(-1);

        let chunk_index = max_index + 1;
        let chunk_id = format!("{}_{}", document_id, chunk_index);

        // Determine next safe rowid
        let meta_max = self
            .db
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                format!("SELECT COALESCE(MAX(rowid), 0) AS max_rid FROM {meta_table}"),
            ))
            .await
            .map_err(Self::wrap)?
            .and_then(|r| r.try_get::<i64>("", "max_rid").ok())
            .unwrap_or(0);

        let vec_max = self
            .db
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                format!("SELECT COALESCE(MAX(rowid), 0) AS max_rid FROM {name}"),
            ))
            .await
            .ok()
            .flatten()
            .and_then(|r| r.try_get::<i64>("", "max_rid").ok())
            .unwrap_or(0);

        let rid: i64 = meta_max.max(vec_max) + 1;
        let vec_json = Self::embedding_to_json(embedding);

        // Insert embedding into vec0
        self.db
            .execute(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                &format!("INSERT INTO {name} (rowid, embedding) VALUES ($1, $2)"),
                vec![rid.into(), vec_json.into()],
            ))
            .await
            .map_err(Self::wrap)?;

        // Insert meta
        self.db
            .execute(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                &format!(
                    "INSERT INTO {meta_table} (rowid, id, document_id, chunk_index, content) \
                     VALUES ($1, $2, $3, $4, $5)"
                ),
                vec![
                    rid.into(),
                    chunk_id.clone().into(),
                    document_id.to_string().into(),
                    chunk_index.into(),
                    content.to_string().into(),
                ],
            ))
            .await
            .map_err(Self::wrap)?;

        Ok(chunk_id)
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

        if !self.table_exists(&format!("{name}_meta")).await? {
            tracing::warn!("Vector store: table {name}_meta does not exist, returning empty");
            return Ok(vec![]);
        }

        let vec_json = Self::embedding_to_json(&query_embedding);

        let sql = format!(
            "SELECT m.id, m.document_id, m.chunk_index, m.content, v.distance \
             FROM {name} v \
             JOIN {name}_meta m ON m.rowid = v.rowid \
             WHERE v.embedding MATCH $1 AND k = $2 \
             ORDER BY v.distance"
        );

        let rows = match self
            .db
            .query_all(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                &sql,
                vec![vec_json.into(), (top_k as i64).into()],
            ))
            .await
        {
            Ok(r) => r,
            Err(e) => {
                tracing::error!("Vector store: search query failed for {name}: {e}");
                return Ok(vec![]);
            }
        };

        let mut results = Vec::with_capacity(rows.len());
        for row in &rows {
            results.push(VectorSearchResult {
                id: row.try_get("", "id").map_err(Self::wrap)?,
                document_id: row.try_get("", "document_id").map_err(Self::wrap)?,
                chunk_index: row.try_get("", "chunk_index").map_err(Self::wrap)?,
                content: row.try_get("", "content").map_err(Self::wrap)?,
                score: row
                    .try_get::<f64>("", "distance")
                    .map(|v| v as f32)
                    .map_err(Self::wrap)?,
                rerank_score: None,
                has_embedding: true,
            });
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

        if !self.table_exists(&format!("{name}_meta")).await? {
            return Ok(());
        }

        self.delete_rows_by_document(&name, document_id).await
    }

    /// Drop both tables for a knowledge base.
    ///
    /// Silently succeeds if the tables do not exist.
    pub async fn delete_collection(&self, knowledge_base_id: &str) -> Result<()> {
        let name = Self::collection_name(knowledge_base_id);
        let _ = self.exec(&format!("DROP TABLE IF EXISTS {name}")).await;
        let _ = self
            .exec(&format!("DROP TABLE IF EXISTS {name}_meta"))
            .await;
        Ok(())
    }

    /// Clear only the embedding vectors (vec0), keeping chunk metadata (_meta) intact.
    /// This allows re-embedding without losing user edits or manually added chunks.
    pub async fn clear_embeddings(&self, collection_id: &str) -> Result<()> {
        let name = Self::collection_name(collection_id);

        // Drop and recreate vec0 to clear all embeddings
        // We need the dimensions to recreate, so read from an existing row first
        let dim_row = self
            .db
            .query_one(Statement::from_string(
                DbBackend::Sqlite,
                format!("SELECT vec_length(embedding) AS dim FROM {name} LIMIT 1"),
            ))
            .await
            .ok()
            .flatten();

        let _ = self.exec(&format!("DROP TABLE IF EXISTS {name}")).await;

        // Recreate vec0 if we know the dimensions
        if let Some(row) = dim_row {
            if let Ok(dim) = row.try_get::<i32>("", "dim") {
                let _ = self
                    .exec(&format!(
                        "CREATE VIRTUAL TABLE IF NOT EXISTS {name} USING vec0(embedding float[{dim}])"
                    ))
                    .await;
            }
        }

        Ok(())
    }

    /// List all chunk metadata with rowids for re-embedding.
    /// Returns (rowid, chunk_id, content) tuples.
    pub async fn list_all_chunks(&self, collection_id: &str) -> Result<Vec<(i64, String, String)>> {
        self.list_chunks_raw(collection_id, None).await
    }

    /// List chunks (rowid, id, content) for a specific document.
    pub async fn list_document_chunks_raw(
        &self,
        collection_id: &str,
        document_id: &str,
    ) -> Result<Vec<(i64, String, String)>> {
        self.list_chunks_raw(collection_id, Some(document_id)).await
    }

    /// Internal helper: list chunks with optional document_id filter.
    async fn list_chunks_raw(
        &self,
        collection_id: &str,
        document_id: Option<&str>,
    ) -> Result<Vec<(i64, String, String)>> {
        let name = Self::collection_name(collection_id);
        let meta_table = format!("{name}_meta");

        if !self.table_exists(&meta_table).await? {
            return Ok(vec![]);
        }

        let rows = if let Some(doc_id) = document_id {
            self.db
                .query_all(Statement::from_sql_and_values(
                    DbBackend::Sqlite,
                    &format!("SELECT rowid, id, content FROM \"{meta_table}\" WHERE document_id = $1 ORDER BY rowid"),
                    vec![doc_id.to_string().into()],
                ))
                .await
                .map_err(Self::wrap)?
        } else {
            self.db
                .query_all(Statement::from_string(
                    DbBackend::Sqlite,
                    format!("SELECT rowid, id, content FROM {meta_table} ORDER BY rowid"),
                ))
                .await
                .map_err(Self::wrap)?
        };

        let mut result = Vec::new();
        for row in &rows {
            let rid: i64 = row.try_get("", "rowid").map_err(Self::wrap)?;
            let id: String = row.try_get("", "id").map_err(Self::wrap)?;
            let content: String = row.try_get("", "content").map_err(Self::wrap)?;
            result.push((rid, id, content));
        }

        Ok(result)
    }

    /// Re-insert embeddings for existing chunks (used after clear_embeddings).
    /// The vec0 table must already exist (or be recreated with correct dimensions).
    pub async fn reinsert_embeddings(
        &self,
        collection_id: &str,
        entries: Vec<(i64, Vec<f32>)>, // (rowid, embedding)
    ) -> Result<()> {
        self.upsert_document_embeddings(collection_id, entries)
            .await
    }

    /// Insert or replace embeddings for specific rowids.
    /// Creates vec0 if needed, deletes existing rows, then inserts new embeddings.
    pub async fn upsert_document_embeddings(
        &self,
        collection_id: &str,
        entries: Vec<(i64, Vec<f32>)>,
    ) -> Result<()> {
        if entries.is_empty() {
            return Ok(());
        }

        let dimensions = entries[0].1.len();
        let name = Self::collection_name(collection_id);

        // Ensure the vec0 table exists with correct dimensions
        self.db
            .execute(Statement::from_string(
                DbBackend::Sqlite,
                format!("CREATE VIRTUAL TABLE IF NOT EXISTS {name} USING vec0(embedding float[{dimensions}])"),
            ))
            .await
            .map_err(Self::wrap)?;

        for (rid, embedding) in &entries {
            // Delete existing row if present (ignore errors — may not exist)
            let _ = self
                .db
                .execute(Statement::from_sql_and_values(
                    DbBackend::Sqlite,
                    &format!("DELETE FROM {name} WHERE rowid = $1"),
                    vec![(*rid).into()],
                ))
                .await;

            let vec_json = Self::embedding_to_json(embedding);
            self.db
                .execute(Statement::from_sql_and_values(
                    DbBackend::Sqlite,
                    &format!("INSERT INTO {name} (rowid, embedding) VALUES ($1, $2)"),
                    vec![(*rid).into(), vec_json.into()],
                ))
                .await
                .map_err(Self::wrap)?;
        }

        Ok(())
    }

    /// Delete a single chunk by its id from both vec0 and metadata tables.
    pub async fn delete_chunk(&self, collection_id: &str, chunk_id: &str) -> Result<()> {
        let name = Self::collection_name(collection_id);
        let meta_table = format!("{name}_meta");

        if !self.table_exists(&meta_table).await? {
            return Ok(());
        }

        // Get the rowid from _meta
        let row = self
            .db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                &format!("SELECT rowid FROM {meta_table} WHERE id = $1"),
                vec![chunk_id.to_string().into()],
            ))
            .await
            .map_err(Self::wrap)?;

        if let Some(row) = row {
            let rid: i64 = row.try_get("", "rowid").map_err(Self::wrap)?;
            // Delete from vec0
            let _ = self
                .db
                .execute(Statement::from_sql_and_values(
                    DbBackend::Sqlite,
                    &format!("DELETE FROM {name} WHERE rowid = $1"),
                    vec![rid.into()],
                ))
                .await;
            // Delete from _meta
            self.db
                .execute(Statement::from_sql_and_values(
                    DbBackend::Sqlite,
                    &format!("DELETE FROM {meta_table} WHERE id = $1"),
                    vec![chunk_id.to_string().into()],
                ))
                .await
                .map_err(Self::wrap)?;
        }

        Ok(())
    }

    /// Update the text content of a single chunk in the metadata table.
    pub async fn update_chunk_content(
        &self,
        collection_id: &str,
        chunk_id: &str,
        new_content: &str,
    ) -> Result<()> {
        let name = Self::collection_name(collection_id);
        let meta_table = format!("{name}_meta");

        if !self.table_exists(&meta_table).await? {
            return Err(AQBotError::NotFound("Collection not found".into()));
        }

        self.db
            .execute(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                &format!("UPDATE {meta_table} SET content = $1 WHERE id = $2"),
                vec![new_content.to_string().into(), chunk_id.to_string().into()],
            ))
            .await
            .map_err(Self::wrap)?;

        Ok(())
    }

    /// Update the embedding vector for a single chunk identified by its chunk id.
    pub async fn update_chunk_embedding(
        &self,
        collection_id: &str,
        chunk_id: &str,
        embedding: &[f32],
    ) -> Result<()> {
        let name = Self::collection_name(collection_id);
        let meta_table = format!("{name}_meta");

        if !self.table_exists(&meta_table).await? {
            return Err(AQBotError::NotFound("Collection not found".into()));
        }

        // Get the rowid from _meta
        let row = self
            .db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                &format!("SELECT rowid FROM {meta_table} WHERE id = $1"),
                vec![chunk_id.to_string().into()],
            ))
            .await
            .map_err(Self::wrap)?
            .ok_or_else(|| AQBotError::NotFound(format!("Chunk {} not found", chunk_id)))?;

        let rid: i64 = row.try_get("", "rowid").map_err(Self::wrap)?;
        let vec_json = Self::embedding_to_json(embedding);

        // Update embedding in vec0
        self.db
            .execute(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                &format!("UPDATE {name} SET embedding = $1 WHERE rowid = $2"),
                vec![vec_json.into(), rid.into()],
            ))
            .await
            .map_err(Self::wrap)?;

        Ok(())
    }

    // ── private helpers ─────────────────────────────────────────────────

    /// Delete rows from both vec0 and metadata tables by `document_id`.
    async fn delete_rows_by_document(&self, table_name: &str, document_id: &str) -> Result<()> {
        let rows = self
            .db
            .query_all(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                &format!("SELECT rowid FROM {table_name}_meta WHERE document_id = $1"),
                vec![document_id.to_string().into()],
            ))
            .await
            .map_err(Self::wrap)?;

        for row in &rows {
            let rid: i64 = row.try_get("", "rowid").map_err(Self::wrap)?;
            self.db
                .execute(Statement::from_sql_and_values(
                    DbBackend::Sqlite,
                    &format!("DELETE FROM {table_name} WHERE rowid = $1"),
                    vec![rid.into()],
                ))
                .await
                .map_err(Self::wrap)?;
        }

        self.db
            .execute(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                &format!("DELETE FROM {table_name}_meta WHERE document_id = $1"),
                vec![document_id.to_string().into()],
            ))
            .await
            .map_err(Self::wrap)?;

        Ok(())
    }

    /// Convert an embedding vector to a JSON array string for sqlite-vec.
    fn embedding_to_json(embedding: &[f32]) -> String {
        format!(
            "[{}]",
            embedding
                .iter()
                .map(|v| v.to_string())
                .collect::<Vec<_>>()
                .join(",")
        )
    }

    /// Check whether a regular table exists in the database.
    async fn table_exists(&self, table_name: &str) -> Result<bool> {
        let row = self
            .db
            .query_one(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                "SELECT name FROM sqlite_master WHERE type='table' AND name=$1",
                vec![table_name.to_string().into()],
            ))
            .await
            .map_err(Self::wrap)?;
        Ok(row.is_some())
    }

    /// List all chunks stored for a specific document within a collection.
    pub async fn list_document_chunks(
        &self,
        collection_id: &str,
        document_id: &str,
    ) -> Result<Vec<VectorSearchResult>> {
        let name = Self::collection_name(collection_id);
        let meta_table = format!("{name}_meta");

        if !self.table_exists(&meta_table).await? {
            return Ok(vec![]);
        }

        let vec_exists = self.table_exists(&name).await?;

        let sql = if vec_exists {
            format!(
                "SELECT m.id, m.document_id, m.chunk_index, m.content, \
                 CASE WHEN v.rowid IS NOT NULL THEN 1 ELSE 0 END AS has_embedding \
                 FROM \"{meta_table}\" m \
                 LEFT JOIN \"{name}\" v ON m.rowid = v.rowid \
                 WHERE m.document_id = $1 ORDER BY m.chunk_index"
            )
        } else {
            format!(
                "SELECT id, document_id, chunk_index, content, 0 AS has_embedding \
                 FROM \"{meta_table}\" WHERE document_id = $1 ORDER BY chunk_index"
            )
        };

        let rows = self
            .db
            .query_all(Statement::from_sql_and_values(
                DbBackend::Sqlite,
                &sql,
                vec![document_id.to_string().into()],
            ))
            .await
            .map_err(Self::wrap)?;

        let mut results = Vec::with_capacity(rows.len());
        for row in &rows {
            let has_emb: i32 = row.try_get("", "has_embedding").unwrap_or(0);
            results.push(VectorSearchResult {
                id: row.try_get("", "id").map_err(Self::wrap)?,
                document_id: row.try_get("", "document_id").map_err(Self::wrap)?,
                chunk_index: row.try_get("", "chunk_index").map_err(Self::wrap)?,
                content: row.try_get("", "content").map_err(Self::wrap)?,
                score: 0.0,
                rerank_score: None,
                has_embedding: has_emb != 0,
            });
        }

        Ok(results)
    }

    /// Shorthand for executing a statement with no parameters.
    async fn exec(&self, sql: &str) -> Result<()> {
        self.db
            .execute(Statement::from_string(DbBackend::Sqlite, sql))
            .await
            .map_err(Self::wrap)?;
        Ok(())
    }

    fn wrap(e: DbErr) -> AQBotError {
        AQBotError::Provider(format!("Vector store error: {e}"))
    }
}
