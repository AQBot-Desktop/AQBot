use crate::AppState;
use aqbot_core::mcp_client::{StdioClientManager, StdioServerLaunch, StdioToolCall};
use aqbot_core::types::*;
use aqbot_providers::{
    registry::ProviderRegistry, resolve_base_url_for_type, ProviderAdapter, ProviderRequestContext,
};
use base64::Engine;
use sea_orm::*;
use std::collections::{HashMap, HashSet, VecDeque};
use std::future::Future;
use std::sync::atomic::AtomicBool;
use std::sync::Arc;
use std::time::Duration;
use tauri::{Emitter, Manager, State};

include!("conversations/provider_and_stream_config.rs");
include!("conversations/message_persistence.rs");
include!("conversations/content.rs");
include!("conversations/document_attachments.rs");
include!("conversations/context_history.rs");
include!("conversations/crud.rs");
include!("conversations/stream_runtime.rs");
include!("conversations/titles.rs");
include!("conversations/search_query.rs");
include!("conversations/rag.rs");
include!("conversations/message_streaming.rs");
include!("conversations/message_versions.rs");
include!("conversations/compression.rs");
include!("conversations/tests.rs");
#[cfg(test)]
include!("conversations/multi_model_continuation_tests.rs");
