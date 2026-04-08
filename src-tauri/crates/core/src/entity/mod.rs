//! SeaORM entity definitions for AQBot database tables.

pub mod conversation_categories;
pub mod conversation_summaries;
pub mod conversations;
pub mod desktop_state;
pub mod gateway_diagnostics;
pub mod gateway_keys;
pub mod gateway_request_logs;
pub mod gateway_usage;
pub mod mcp_servers;
pub mod messages;
pub mod models;
pub mod program_policies;
pub mod provider_keys;
pub mod providers;
pub mod search_citations;
pub mod search_providers;
pub mod settings;
pub mod skill_states;
pub mod tool_descriptors;
pub mod tool_executions;

// Wave 2+ entities
pub mod artifacts;
pub mod backup_manifests;
pub mod backup_targets;
pub mod context_sources;
pub mod conversation_branches;
pub mod import_jobs;
pub mod knowledge_bases;
pub mod knowledge_documents;
pub mod memory_items;
pub mod memory_namespaces;
pub mod retrieval_hits;

pub mod stored_files;

pub mod agent_sessions;

pub use sea_orm;
