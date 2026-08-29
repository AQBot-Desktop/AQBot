//! ACP workbench Tauri commands.

use crate::AppState;
use aqbot_acp_client::config::{
    apply_registry_refresh, commit_registry_agent, enabled_agents, is_agent_enabled,
    load_agents_file, migrate_agents_file, preview_registry_agent, probe_agent, remove_agent,
    reorder_agents, save_agents_file, set_agent_enabled, AcpAgentsFile, AcpGeneralConfig,
    ConfiguredAgent, QuarantinedConfiguredAgent, RegistryAddPreview,
};
use aqbot_acp_client::proxy::{
    configured_agent_with_proxy, resolve_proxy_environment, resolve_system_proxy,
    ProcessProxySettings,
};
use aqbot_acp_client::registry::{
    find_registry_agent, load_registry, refresh_registry_with_proxy, resolve_launch, RegistryFile,
    RegistrySource,
};
use aqbot_acp_client::runtime::{
    configured_agent_with_model, configured_agent_with_reasoning_effort, persisted_mode_id,
    AcpEvent, AcpInteractionKind, AcpInteractionOutcome, AcpQuestionnaireAnswer,
    AcpQuestionnaireOutcome, AcpQuestionnaireSubmission, AcpRuntime, AcpSessionSnapshot,
    RuntimeLimits,
};
use aqbot_acp_client::types::AgentProbeResult;
use aqbot_acp_client::{AcpPromptAttachment, AcpPromptInput};
use aqbot_core::repo::acp as acp_repo;
use aqbot_core::types::{AppSettings, Attachment, AttachmentInput};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicU64, Ordering as AtomicOrdering},
    Arc,
};
use tauri::{AppHandle, Emitter, State};
use tokio::sync::{mpsc, Mutex};

include!("acp/runtime.rs");
include!("acp/workspace.rs");
include!("acp/transcript.rs");
include!("acp/config.rs");
include!("acp/session.rs");
include!("acp/prompt.rs");
include!("acp/git.rs");
