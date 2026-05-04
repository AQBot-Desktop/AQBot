use aqbot_migration::MigratorTrait;
use sea_orm::{
    ConnectOptions, ConnectionTrait, Database, DatabaseConnection, DbBackend, Statement,
};
use tracing::info;

use crate::error::Result;
use crate::repo::provider;
use crate::types::*;

pub struct DbHandle {
    pub conn: DatabaseConnection,
}

pub async fn create_pool(db_path: &str) -> Result<DbHandle> {
    let url = if db_path.starts_with("sqlite:") {
        format!("{}?mode=rwc", db_path)
    } else {
        format!("sqlite:{}?mode=rwc", db_path)
    };

    let mut opt = ConnectOptions::new(&url);
    opt.max_connections(5)
        .min_connections(1)
        .sqlx_logging(false);

    let conn = Database::connect(opt).await?;

    // Enable WAL journal mode and foreign keys via PRAGMA
    conn.execute(Statement::from_string(
        DbBackend::Sqlite,
        "PRAGMA journal_mode=WAL;",
    ))
    .await?;
    conn.execute(Statement::from_string(
        DbBackend::Sqlite,
        "PRAGMA foreign_keys=ON;",
    ))
    .await?;

    // Run SeaORM migrations
    aqbot_migration::Migrator::up(&conn, None).await?;

    info!("Database initialized at {}", db_path);
    Ok(DbHandle { conn })
}

pub struct BuiltinProvider {
    pub builtin_id: &'static str,
    pub name: &'static str,
    pub provider_type: ProviderType,
    pub api_host: &'static str,
    pub models: Vec<BuiltinModel>,
}

pub struct BuiltinModel {
    pub model_id: &'static str,
    pub name: &'static str,
    pub group_name: Option<&'static str>,
    pub model_type: Option<ModelType>,
    pub capabilities: Vec<ModelCapability>,
    pub max_tokens: Option<u32>,
    pub enabled: bool,
    pub param_overrides: Option<ModelParamOverrides>,
}

impl BuiltinModel {
    fn chat(
        model_id: &'static str,
        name: &'static str,
        capabilities: Vec<ModelCapability>,
        max_tokens: Option<u32>,
    ) -> Self {
        Self {
            model_id,
            name,
            group_name: None,
            model_type: Some(ModelType::Chat),
            capabilities,
            max_tokens,
            enabled: true,
            param_overrides: None,
        }
    }

    fn image(model_id: &'static str, name: &'static str) -> Self {
        Self {
            model_id,
            name,
            group_name: Some("gpt-image"),
            model_type: Some(ModelType::Image),
            capabilities: vec![],
            max_tokens: None,
            enabled: true,
            param_overrides: None,
        }
    }

    fn rerank(model_id: &'static str, name: &'static str) -> Self {
        Self {
            model_id,
            name,
            group_name: None,
            model_type: Some(ModelType::Rerank),
            capabilities: vec![],
            max_tokens: None,
            enabled: true,
            param_overrides: None,
        }
    }

    fn disabled(mut self) -> Self {
        self.enabled = false;
        self
    }

    fn with_param_overrides(mut self, param_overrides: ModelParamOverrides) -> Self {
        self.param_overrides = Some(param_overrides);
        self
    }

    pub(crate) fn to_model(&self, provider_id: &str) -> Model {
        Model {
            provider_id: provider_id.to_string(),
            model_id: self.model_id.to_string(),
            name: self.name.to_string(),
            group_name: self.group_name.map(str::to_string),
            model_type: self
                .model_type
                .clone()
                .unwrap_or_else(|| ModelType::detect(self.model_id)),
            capabilities: self.capabilities.clone(),
            max_tokens: self.max_tokens,
            enabled: self.enabled,
            param_overrides: self.param_overrides.clone(),
        }
    }
}

fn empty_param_overrides() -> ModelParamOverrides {
    ModelParamOverrides {
        temperature: None,
        max_tokens: None,
        top_p: None,
        frequency_penalty: None,
        use_max_completion_tokens: None,
        no_system_role: None,
        force_max_tokens: None,
        thinking_param_style: None,
        reasoning_profile: None,
        reasoning_options: None,
        reasoning_default: None,
    }
}

fn reasoning_profile(profile: &'static str) -> ModelParamOverrides {
    let mut overrides = empty_param_overrides();
    overrides.reasoning_profile = Some(profile.to_string());
    overrides
}

fn openai_reasoning_profile() -> ModelParamOverrides {
    let mut overrides = reasoning_profile("openai_reasoning_effort");
    overrides.use_max_completion_tokens = Some(true);
    overrides
}

fn minimax_m2_profile() -> ModelParamOverrides {
    let mut overrides = empty_param_overrides();
    overrides.max_tokens = Some(2048);
    overrides.use_max_completion_tokens = Some(true);
    overrides
}

pub fn get_builtin_providers() -> Vec<BuiltinProvider> {
    use ModelCapability::*;

    vec![
        BuiltinProvider {
            builtin_id: "openai",
            name: "OpenAI",
            provider_type: ProviderType::OpenAI,
            api_host: "https://api.openai.com",
            models: vec![
                BuiltinModel::chat(
                    "gpt-5.5",
                    "GPT-5.5",
                    vec![TextChat, Vision, FunctionCalling, Reasoning],
                    Some(1_000_000),
                )
                .with_param_overrides(openai_reasoning_profile()),
                BuiltinModel::chat(
                    "gpt-5.4",
                    "GPT-5.4",
                    vec![TextChat, Vision, FunctionCalling, Reasoning],
                    Some(1_000_000),
                )
                .with_param_overrides(openai_reasoning_profile()),
                BuiltinModel::chat(
                    "gpt-5.4-mini",
                    "GPT-5.4 Mini",
                    vec![TextChat, Vision, FunctionCalling, Reasoning],
                    Some(400_000),
                )
                .with_param_overrides(openai_reasoning_profile()),
                BuiltinModel::chat(
                    "gpt-5.4-nano",
                    "GPT-5.4 Nano",
                    vec![TextChat, Vision, FunctionCalling, Reasoning],
                    Some(400_000),
                )
                .with_param_overrides(openai_reasoning_profile())
                .disabled(),
                BuiltinModel::chat(
                    "gpt-4.1",
                    "GPT-4.1",
                    vec![TextChat, Vision, FunctionCalling],
                    Some(1_047_576),
                ),
                BuiltinModel::chat(
                    "gpt-4.1-mini",
                    "GPT-4.1 Mini",
                    vec![TextChat, Vision, FunctionCalling],
                    Some(1_047_576),
                ),
                BuiltinModel::chat(
                    "gpt-4.1-nano",
                    "GPT-4.1 Nano",
                    vec![TextChat, Vision, FunctionCalling],
                    Some(1_047_576),
                )
                .disabled(),
                BuiltinModel::chat(
                    "gpt-4o",
                    "GPT-4o",
                    vec![TextChat, Vision, FunctionCalling],
                    Some(128_000),
                )
                .disabled(),
                BuiltinModel::chat(
                    "gpt-4o-mini",
                    "GPT-4o Mini",
                    vec![TextChat, Vision, FunctionCalling],
                    Some(128_000),
                )
                .disabled(),
                BuiltinModel::chat(
                    "o3",
                    "o3",
                    vec![TextChat, Reasoning, FunctionCalling],
                    Some(200_000),
                )
                .with_param_overrides(openai_reasoning_profile()),
                BuiltinModel::chat(
                    "o4-mini",
                    "o4-mini",
                    vec![TextChat, Reasoning, FunctionCalling],
                    Some(200_000),
                )
                .with_param_overrides(openai_reasoning_profile()),
                BuiltinModel::image("gpt-image-2", "gpt-image-2"),
                BuiltinModel::image("gpt-image-1.5", "gpt-image-1.5"),
                BuiltinModel::image("gpt-image-1", "gpt-image-1").disabled(),
                BuiltinModel::image("gpt-image-1-mini", "gpt-image-1-mini").disabled(),
            ],
        },
        BuiltinProvider {
            builtin_id: "openai_responses",
            name: "OpenAI Responses",
            provider_type: ProviderType::OpenAIResponses,
            api_host: "https://api.openai.com",
            models: vec![
                BuiltinModel::chat(
                    "gpt-5.5",
                    "GPT-5.5",
                    vec![TextChat, Vision, FunctionCalling, Reasoning],
                    Some(1_000_000),
                )
                .with_param_overrides(reasoning_profile("openai_responses_reasoning")),
                BuiltinModel::chat(
                    "gpt-5.4",
                    "GPT-5.4",
                    vec![TextChat, Vision, FunctionCalling, Reasoning],
                    Some(1_000_000),
                )
                .with_param_overrides(reasoning_profile("openai_responses_reasoning")),
                BuiltinModel::chat(
                    "gpt-5.4-mini",
                    "GPT-5.4 Mini",
                    vec![TextChat, Vision, FunctionCalling, Reasoning],
                    Some(400_000),
                )
                .with_param_overrides(reasoning_profile("openai_responses_reasoning")),
                BuiltinModel::chat(
                    "gpt-4.1",
                    "GPT-4.1",
                    vec![TextChat, Vision, FunctionCalling],
                    Some(1_047_576),
                ),
                BuiltinModel::chat(
                    "gpt-4o",
                    "GPT-4o",
                    vec![TextChat, Vision, FunctionCalling],
                    Some(128_000),
                )
                .disabled(),
                BuiltinModel::chat(
                    "gpt-4o-mini",
                    "GPT-4o Mini",
                    vec![TextChat, Vision, FunctionCalling],
                    Some(128_000),
                )
                .disabled(),
                BuiltinModel::chat(
                    "o3",
                    "o3",
                    vec![TextChat, Reasoning, FunctionCalling],
                    Some(200_000),
                )
                .with_param_overrides(reasoning_profile("openai_responses_reasoning")),
                BuiltinModel::chat(
                    "o4-mini",
                    "o4-mini",
                    vec![TextChat, Reasoning, FunctionCalling],
                    Some(200_000),
                )
                .with_param_overrides(reasoning_profile("openai_responses_reasoning")),
            ],
        },
        BuiltinProvider {
            builtin_id: "gemini",
            name: "Gemini",
            provider_type: ProviderType::Gemini,
            api_host: "https://generativelanguage.googleapis.com",
            models: vec![
                BuiltinModel::chat(
                    "gemini-3.1-pro-preview",
                    "Gemini 3.1 Pro Preview",
                    vec![TextChat, Vision, FunctionCalling, Reasoning],
                    Some(1_048_576),
                )
                .with_param_overrides(reasoning_profile("gemini_thinking_level")),
                BuiltinModel::chat(
                    "gemini-3.1-flash-lite-preview",
                    "Gemini 3.1 Flash-Lite Preview",
                    vec![TextChat, Vision, FunctionCalling, Reasoning],
                    Some(1_048_576),
                )
                .with_param_overrides(reasoning_profile("gemini_thinking_level")),
                BuiltinModel::chat(
                    "gemini-2.5-pro",
                    "Gemini 2.5 Pro",
                    vec![TextChat, Vision, FunctionCalling, Reasoning],
                    Some(1_048_576),
                )
                .with_param_overrides(reasoning_profile("gemini_thinking_budget")),
                BuiltinModel::chat(
                    "gemini-2.5-flash",
                    "Gemini 2.5 Flash",
                    vec![TextChat, Vision, FunctionCalling, Reasoning],
                    Some(1_048_576),
                )
                .with_param_overrides(reasoning_profile("gemini_thinking_budget")),
                BuiltinModel::chat(
                    "gemini-2.5-flash-lite",
                    "Gemini 2.5 Flash-Lite",
                    vec![TextChat, Vision, FunctionCalling, Reasoning],
                    Some(1_048_576),
                )
                .with_param_overrides(reasoning_profile("gemini_thinking_budget")),
                BuiltinModel::chat(
                    "gemini-2.0-flash",
                    "Gemini 2.0 Flash",
                    vec![TextChat, Vision, FunctionCalling],
                    Some(1_048_576),
                )
                .disabled(),
            ],
        },
        BuiltinProvider {
            builtin_id: "anthropic",
            name: "Claude",
            provider_type: ProviderType::Anthropic,
            api_host: "https://api.anthropic.com",
            models: vec![
                BuiltinModel::chat(
                    "claude-opus-4-7-20260127",
                    "Claude Opus 4.7",
                    vec![TextChat, Vision, FunctionCalling, Reasoning],
                    Some(200_000),
                )
                .with_param_overrides(reasoning_profile("anthropic_adaptive")),
                BuiltinModel::chat(
                    "claude-sonnet-4-6-20251117",
                    "Claude Sonnet 4.6",
                    vec![TextChat, Vision, FunctionCalling, Reasoning],
                    Some(200_000),
                )
                .with_param_overrides(reasoning_profile("anthropic_adaptive")),
                BuiltinModel::chat(
                    "claude-haiku-4-5-20251001",
                    "Claude Haiku 4.5",
                    vec![TextChat, Vision, FunctionCalling, Reasoning],
                    Some(200_000),
                )
                .with_param_overrides(reasoning_profile("anthropic_budget_tokens")),
            ],
        },
        BuiltinProvider {
            builtin_id: "deepseek",
            name: "DeepSeek",
            provider_type: ProviderType::DeepSeek,
            api_host: "https://api.deepseek.com",
            models: vec![
                BuiltinModel::chat(
                    "deepseek-v4-flash",
                    "DeepSeek v4 Flash",
                    vec![TextChat, Reasoning, FunctionCalling],
                    Some(1_000_000),
                )
                .with_param_overrides(reasoning_profile("openai_reasoning_effort")),
                BuiltinModel::chat(
                    "deepseek-v4-pro",
                    "DeepSeek v4 Pro",
                    vec![TextChat, Reasoning, FunctionCalling],
                    Some(1_000_000),
                )
                .with_param_overrides(reasoning_profile("openai_reasoning_effort")),
                BuiltinModel::chat(
                    "deepseek-chat",
                    "DeepSeek Chat",
                    vec![TextChat, FunctionCalling],
                    Some(64_000),
                )
                .disabled(),
                BuiltinModel::chat(
                    "deepseek-reasoner",
                    "DeepSeek Reasoner",
                    vec![TextChat, Reasoning],
                    Some(64_000),
                )
                .with_param_overrides(reasoning_profile("openai_reasoning_effort"))
                .disabled(),
            ],
        },
        BuiltinProvider {
            builtin_id: "xai",
            name: "xAI",
            provider_type: ProviderType::XAI,
            api_host: "https://api.x.ai",
            models: vec![
                BuiltinModel::chat(
                    "grok-4.3",
                    "Grok 4.3",
                    vec![TextChat, Vision, Reasoning, FunctionCalling],
                    None,
                )
                .with_param_overrides(reasoning_profile("none")),
                BuiltinModel::chat(
                    "grok-3",
                    "Grok 3",
                    vec![TextChat, Vision, FunctionCalling],
                    Some(131_072),
                )
                .disabled(),
                BuiltinModel::chat(
                    "grok-3-mini",
                    "Grok 3 Mini",
                    vec![TextChat, Reasoning, FunctionCalling],
                    Some(131_072),
                )
                .with_param_overrides(reasoning_profile("none"))
                .disabled(),
            ],
        },
        BuiltinProvider {
            builtin_id: "glm",
            name: "GLM",
            provider_type: ProviderType::GLM,
            api_host: "https://open.bigmodel.cn/api/paas",
            models: vec![
                BuiltinModel::chat(
                    "glm-5.1",
                    "GLM-5.1",
                    vec![TextChat, Vision, Reasoning, FunctionCalling],
                    Some(200_000),
                )
                .with_param_overrides(reasoning_profile("glm_thinking")),
                BuiltinModel::chat(
                    "glm-5",
                    "GLM-5",
                    vec![TextChat, Vision, Reasoning, FunctionCalling],
                    Some(128_000),
                )
                .with_param_overrides(reasoning_profile("glm_thinking")),
                BuiltinModel::chat(
                    "glm-4.6",
                    "GLM-4.6",
                    vec![TextChat, Vision, Reasoning, FunctionCalling],
                    Some(128_000),
                )
                .with_param_overrides(reasoning_profile("glm_thinking"))
                .disabled(),
            ],
        },
        BuiltinProvider {
            builtin_id: "siliconflow",
            name: "SiliconFlow",
            provider_type: ProviderType::SiliconFlow,
            api_host: "https://api.siliconflow.cn",
            models: vec![
                BuiltinModel::chat(
                    "deepseek-ai/DeepSeek-V3.2-Exp",
                    "DeepSeek-V3.2-Exp",
                    vec![TextChat, FunctionCalling],
                    Some(64_000),
                ),
                BuiltinModel::chat(
                    "deepseek-ai/DeepSeek-R1",
                    "DeepSeek-R1",
                    vec![TextChat, Reasoning],
                    Some(64_000),
                )
                .with_param_overrides(reasoning_profile("siliconflow_enable_thinking")),
                BuiltinModel::chat(
                    "Qwen/Qwen3-235B-A22B",
                    "Qwen3-235B-A22B",
                    vec![TextChat, Reasoning, FunctionCalling],
                    Some(262_144),
                )
                .with_param_overrides(reasoning_profile("siliconflow_enable_thinking")),
                BuiltinModel::chat(
                    "Qwen/Qwen3-Coder-480B-A35B-Instruct",
                    "Qwen3-Coder-480B-A35B-Instruct",
                    vec![TextChat, FunctionCalling],
                    Some(262_144),
                ),
            ],
        },
        BuiltinProvider {
            builtin_id: "minimax",
            name: "MiniMax",
            provider_type: ProviderType::OpenAI,
            api_host: "https://api.minimax.io",
            models: vec![
                BuiltinModel::chat(
                    "MiniMax-M2.7",
                    "MiniMax-M2.7",
                    vec![TextChat, FunctionCalling],
                    Some(250_000),
                )
                .with_param_overrides(minimax_m2_profile()),
                BuiltinModel::chat(
                    "MiniMax-M2.5",
                    "MiniMax-M2.5",
                    vec![TextChat, FunctionCalling],
                    Some(250_000),
                )
                .with_param_overrides(minimax_m2_profile()),
                BuiltinModel::chat(
                    "MiniMax-M1",
                    "MiniMax-M1",
                    vec![TextChat, Reasoning, FunctionCalling],
                    Some(1_000_000),
                )
                .disabled(),
            ],
        },
        BuiltinProvider {
            builtin_id: "jina",
            name: "Jina",
            provider_type: ProviderType::Jina,
            api_host: "https://api.jina.ai",
            models: vec![
                BuiltinModel::rerank("jina-reranker-v3", "Jina Reranker v3"),
                BuiltinModel::rerank(
                    "jina-reranker-v2-base-multilingual",
                    "Jina Reranker v2 Base Multilingual",
                )
                .disabled(),
                BuiltinModel::rerank("jina-colbert-v2", "Jina ColBERT v2").disabled(),
            ],
        },
        BuiltinProvider {
            builtin_id: "cohere",
            name: "Cohere",
            provider_type: ProviderType::Cohere,
            api_host: "https://api.cohere.com",
            models: vec![
                BuiltinModel::rerank("rerank-v4.0", "Rerank v4.0"),
                BuiltinModel::rerank("rerank-v4.0-pro", "Rerank v4.0 Pro"),
                BuiltinModel::rerank("rerank-v4.0-fast", "Rerank v4.0 Fast"),
                BuiltinModel::rerank("rerank-v3.5", "Rerank v3.5").disabled(),
            ],
        },
        BuiltinProvider {
            builtin_id: "voyage",
            name: "Voyage",
            provider_type: ProviderType::Voyage,
            api_host: "https://api.voyageai.com",
            models: vec![
                BuiltinModel::rerank("rerank-2.5", "Rerank 2.5"),
                BuiltinModel::rerank("rerank-2.5-lite", "Rerank 2.5 Lite"),
                BuiltinModel::rerank("rerank-2", "Rerank 2").disabled(),
                BuiltinModel::rerank("rerank-2-lite", "Rerank 2 Lite").disabled(),
            ],
        },
    ]
}

async fn seed_builtin_providers(db: &DatabaseConnection) -> Result<()> {
    let existing = provider::list_providers(db).await?;
    if !existing.is_empty() {
        return Ok(());
    }

    info!("Seeding built-in providers...");

    let builtins = get_builtin_providers();

    for (idx, bp) in builtins.into_iter().enumerate() {
        let prov = provider::create_provider(
            db,
            CreateProviderInput {
                name: bp.name.to_string(),
                provider_type: bp.provider_type,
                api_host: bp.api_host.to_string(),
                api_path: None,
                enabled: true,
                builtin_id: None,
            },
        )
        .await?;

        let models: Vec<Model> = bp
            .models
            .into_iter()
            .map(|model| model.to_model(&prov.id))
            .collect();

        provider::save_models(db, &prov.id, &models).await?;

        // Set sort order based on insertion index
        provider::update_provider(
            db,
            &prov.id,
            UpdateProviderInput {
                sort_order: Some(idx as i32),
                ..Default::default()
            },
        )
        .await?;
    }

    info!("Seeded built-in providers");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builtin_rerank_providers_are_registered_with_rerank_models() {
        let providers = get_builtin_providers();

        for (builtin_id, provider_type, model_id) in [
            ("jina", ProviderType::Jina, "jina-reranker-v3"),
            ("cohere", ProviderType::Cohere, "rerank-v4.0-pro"),
            ("voyage", ProviderType::Voyage, "rerank-2.5"),
        ] {
            let provider = providers
                .iter()
                .find(|provider| provider.builtin_id == builtin_id)
                .expect("missing rerank provider");

            assert_eq!(provider.provider_type, provider_type);
            assert!(
                provider
                    .models
                    .iter()
                    .any(|model| model.model_id == model_id
                        && model.model_type.as_ref() == Some(&ModelType::Rerank))
            );
        }
    }

    #[test]
    fn builtin_openai_compatible_providers_use_dedicated_types() {
        let providers = get_builtin_providers();

        for (builtin_id, provider_type) in [
            ("deepseek", ProviderType::DeepSeek),
            ("xai", ProviderType::XAI),
            ("glm", ProviderType::GLM),
            ("siliconflow", ProviderType::SiliconFlow),
        ] {
            let provider = providers
                .iter()
                .find(|provider| provider.builtin_id == builtin_id)
                .expect("missing builtin provider");

            assert_eq!(provider.provider_type, provider_type);
        }
    }

    #[test]
    fn builtin_models_include_current_reasoning_params() {
        let providers = get_builtin_providers();
        let provider = providers
            .iter()
            .find(|provider| provider.builtin_id == "deepseek")
            .expect("missing DeepSeek builtin provider");
        let model = provider
            .models
            .iter()
            .find(|model| model.model_id == "deepseek-v4-flash")
            .expect("missing DeepSeek v4 Flash model");

        assert!(model.capabilities.contains(&ModelCapability::Reasoning));
        assert_eq!(model.max_tokens, Some(1_000_000));
        assert_eq!(
            model
                .param_overrides
                .as_ref()
                .and_then(|params| params.reasoning_profile.as_deref()),
            Some("openai_reasoning_effort")
        );

        let minimax = providers
            .iter()
            .find(|provider| provider.builtin_id == "minimax")
            .expect("missing MiniMax builtin provider");
        let m2 = minimax
            .models
            .iter()
            .find(|model| model.model_id == "MiniMax-M2.7")
            .expect("missing MiniMax-M2.7 model");
        assert_eq!(
            m2.param_overrides
                .as_ref()
                .and_then(|params| params.use_max_completion_tokens),
            Some(true)
        );
        assert_eq!(
            m2.param_overrides
                .as_ref()
                .and_then(|params| params.max_tokens),
            Some(2048)
        );
    }
}

pub async fn create_test_pool() -> Result<DbHandle> {
    create_pool("sqlite::memory:").await
}
