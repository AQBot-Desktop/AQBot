pub use sea_orm_migration::prelude::*;

mod m20240101_000001_init;
mod m20240102_000001_add_token_fields;
mod m20240103_000001_add_mcp_timeout_headers;
mod m20240104_000001_add_mcp_icon;
mod m20250105_000001_context_compression;
mod m20250106_000001_add_message_status;
mod m20250107_000001_add_provider_custom_headers;
mod m20250108_000001_add_provider_icon;
mod m20250109_000001_add_conversation_categories;
mod m20250110_000001_add_memory_item_index_status;
mod m20250111_000001_add_memory_item_index_error;
mod m20250113_000001_add_memory_namespace_settings;
mod m20250114_000001_add_memory_namespace_icon_sort;
mod m20250115_000001_add_knowledge_base_icon_sort;
mod m20250116_000001_add_knowledge_base_retrieval_settings;
mod m20250117_000001_add_knowledge_base_chunking_config;
mod m20250118_000001_add_knowledge_document_type;
mod m20250119_000001_add_knowledge_document_index_error;
mod m20250120_000001_add_message_timing;
mod m20250121_000001_add_conversation_parent_id;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20240101_000001_init::Migration),
            Box::new(m20240102_000001_add_token_fields::Migration),
            Box::new(m20240103_000001_add_mcp_timeout_headers::Migration),
            Box::new(m20240104_000001_add_mcp_icon::Migration),
            Box::new(m20250105_000001_context_compression::Migration),
            Box::new(m20250106_000001_add_message_status::Migration),
            Box::new(m20250107_000001_add_provider_custom_headers::Migration),
            Box::new(m20250108_000001_add_provider_icon::Migration),
            Box::new(m20250109_000001_add_conversation_categories::Migration),
            Box::new(m20250110_000001_add_memory_item_index_status::Migration),
            Box::new(m20250111_000001_add_memory_item_index_error::Migration),
            Box::new(m20250113_000001_add_memory_namespace_settings::Migration),
            Box::new(m20250114_000001_add_memory_namespace_icon_sort::Migration),
            Box::new(m20250115_000001_add_knowledge_base_icon_sort::Migration),
            Box::new(m20250116_000001_add_knowledge_base_retrieval_settings::Migration),
            Box::new(m20250117_000001_add_knowledge_base_chunking_config::Migration),
            Box::new(m20250118_000001_add_knowledge_document_type::Migration),
            Box::new(m20250119_000001_add_knowledge_document_index_error::Migration),
            Box::new(m20250120_000001_add_message_timing::Migration),
            Box::new(m20250121_000001_add_conversation_parent_id::Migration),
        ]
    }
}
