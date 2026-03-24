use sea_orm_migration::prelude::*;

#[derive(DeriveMigrationName)]
pub struct Migration;

// ===========================================================================
// Iden enums – one per table, all columns included
// ===========================================================================

#[derive(DeriveIden)]
enum Providers {
    Table,
    Id,
    Name,
    ProviderType,
    ApiHost,
    ApiPath,
    Enabled,
    ProxyConfig,
    SortOrder,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum ProviderKeys {
    Table,
    Id,
    ProviderId,
    KeyEncrypted,
    KeyPrefix,
    Enabled,
    LastValidatedAt,
    LastError,
    RotationIndex,
    CreatedAt,
}

#[derive(DeriveIden)]
enum Models {
    Table,
    ProviderId,
    ModelId,
    Name,
    Capabilities,
    MaxTokens,
    Enabled,
    ParamOverrides,
    ModelType,
    GroupName,
}

#[derive(DeriveIden)]
enum Conversations {
    Table,
    Id,
    Title,
    ModelId,
    ProviderId,
    AppId,
    SystemPrompt,
    Temperature,
    MaxTokens,
    TopP,
    FrequencyPenalty,
    MessageCount,
    IsPinned,
    IsArchived,
    WorkspaceSnapshotJson,
    ActiveBranchId,
    ActiveArtifactId,
    ResearchMode,
    SearchEnabled,
    SearchProviderId,
    ThinkingBudget,
    EnabledMcpServerIds,
    EnabledKnowledgeBaseIds,
    EnabledMemoryNamespaceIds,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum Messages {
    Table,
    Id,
    ConversationId,
    Role,
    Content,
    ProviderId,
    ModelId,
    TokenCount,
    Attachments,
    Thinking,
    ParentMessageId,
    VersionIndex,
    IsActive,
    BranchId,
    ToolCallsJson,
    ToolCallId,
    CreatedAt,
}

#[derive(DeriveIden)]
enum Categories {
    Table,
    Id,
    Name,
    SortOrder,
}

#[derive(DeriveIden)]
enum Apps {
    Table,
    Id,
    Name,
    Description,
    Icon,
    IconColor,
    SystemPrompt,
    DefaultModelId,
    DefaultProviderId,
    Temperature,
    MaxTokens,
    TopP,
    CategoryId,
    IsFavorite,
    Variables,
    SearchPolicyJson,
    ToolBindingJson,
    KnowledgeBindingJson,
    MemoryPolicyJson,
    CreatedAt,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum GatewayKeys {
    Table,
    Id,
    Name,
    KeyHash,
    KeyPrefix,
    EncryptedKey,
    Enabled,
    CreatedAt,
    LastUsedAt,
}

#[derive(DeriveIden)]
enum GatewayUsage {
    Table,
    Id,
    KeyId,
    ProviderId,
    ModelId,
    RequestTokens,
    ResponseTokens,
    CreatedAt,
}

#[derive(DeriveIden)]
enum Settings {
    Table,
    Key,
    Value,
}

#[derive(DeriveIden)]
enum SearchProviders {
    Table,
    Id,
    Name,
    ProviderType,
    Endpoint,
    ApiKeyRef,
    Enabled,
    Region,
    Language,
    SafeSearch,
    ResultLimit,
    TimeoutMs,
}

#[derive(DeriveIden)]
enum SearchCitations {
    Table,
    Id,
    ConversationId,
    MessageId,
    Title,
    Url,
    Snippet,
    ProviderId,
    Rank,
}

#[derive(DeriveIden)]
enum McpServers {
    Table,
    Id,
    Name,
    Transport,
    Command,
    ArgsJson,
    Endpoint,
    EnvJson,
    Enabled,
    PermissionPolicy,
    Source,
}

#[derive(DeriveIden)]
enum ToolDescriptors {
    Table,
    Id,
    ServerId,
    Name,
    Description,
    InputSchemaJson,
}

#[derive(DeriveIden)]
enum ToolExecutions {
    Table,
    Id,
    ConversationId,
    MessageId,
    ServerId,
    ToolName,
    Status,
    InputPreview,
    OutputPreview,
    ErrorMessage,
    DurationMs,
    CreatedAt,
}

#[derive(DeriveIden)]
enum KnowledgeBases {
    Table,
    Id,
    Name,
    Description,
    EmbeddingProvider,
    Enabled,
}

#[derive(DeriveIden)]
enum KnowledgeDocuments {
    Table,
    Id,
    KnowledgeBaseId,
    Title,
    SourcePath,
    MimeType,
    SizeBytes,
    IndexingStatus,
}

#[derive(DeriveIden)]
enum RetrievalHits {
    Table,
    Id,
    ConversationId,
    MessageId,
    KnowledgeBaseId,
    DocumentId,
    ChunkRef,
    Score,
    Preview,
}

#[derive(DeriveIden)]
enum MemoryNamespaces {
    Table,
    Id,
    Name,
    Scope,
    AppId,
    EmbeddingProvider,
}

#[derive(DeriveIden)]
enum MemoryItems {
    Table,
    Id,
    NamespaceId,
    Title,
    Content,
    Source,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum Artifacts {
    Table,
    Id,
    ConversationId,
    Kind,
    Title,
    Content,
    Format,
    Pinned,
    UpdatedAt,
}

#[derive(DeriveIden)]
enum ContextPacks {
    Table,
    Id,
    AppId,
    Name,
    Content,
    EnabledByDefault,
}

#[derive(DeriveIden)]
enum ContextSources {
    Table,
    Id,
    ConversationId,
    MessageId,
    #[sea_orm(iden = "type")]
    SourceType,
    RefId,
    Title,
    Enabled,
    Summary,
}

#[derive(DeriveIden)]
enum ConversationBranches {
    Table,
    Id,
    ConversationId,
    ParentMessageId,
    BranchLabel,
    BranchIndex,
    ComparedMessageIdsJson,
    CreatedAt,
}

#[derive(DeriveIden)]
enum BackupManifests {
    Table,
    Id,
    Version,
    CreatedAt,
    Encrypted,
    Checksum,
    ObjectCountsJson,
    SourceAppVersion,
    FilePath,
    FileSize,
}

#[derive(DeriveIden)]
enum BackupTargets {
    Table,
    Id,
    Kind,
    ConfigJson,
}

#[derive(DeriveIden)]
enum ImportJobs {
    Table,
    Id,
    SourceType,
    Status,
    SummaryJson,
    ConflictCount,
    CreatedAt,
}

#[derive(DeriveIden)]
enum ProgramPolicies {
    Table,
    Id,
    ProgramName,
    AllowedProviderIdsJson,
    AllowedModelIdsJson,
    DefaultProviderId,
    DefaultModelId,
    RateLimitPerMinute,
}

#[derive(DeriveIden)]
enum GatewayDiagnostics {
    Table,
    Id,
    Category,
    Status,
    Message,
    CreatedAt,
}

#[derive(DeriveIden)]
enum DesktopState {
    Table,
    WindowKey,
    Width,
    Height,
    X,
    Y,
    Maximized,
    Visible,
}

#[derive(DeriveIden)]
enum StoredFiles {
    Table,
    Id,
    Hash,
    OriginalName,
    MimeType,
    SizeBytes,
    StoragePath,
    ConversationId,
    CreatedAt,
}

#[derive(DeriveIden)]
enum GatewayRequestLogs {
    Table,
    Id,
    KeyId,
    KeyName,
    Method,
    Path,
    Model,
    ProviderId,
    StatusCode,
    DurationMs,
    RequestTokens,
    ResponseTokens,
    ErrorMessage,
    CreatedAt,
}

// ===========================================================================
// Migration implementation
// ===========================================================================

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // =================================================================
        // 1. Providers
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(Providers::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(Providers::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(Providers::Name).string().not_null())
                    .col(ColumnDef::new(Providers::ProviderType).string().not_null())
                    .col(ColumnDef::new(Providers::ApiHost).string().not_null())
                    .col(ColumnDef::new(Providers::ApiPath).string().null())
                    .col(ColumnDef::new(Providers::Enabled).integer().not_null().default(1))
                    .col(ColumnDef::new(Providers::ProxyConfig).string().null())
                    .col(ColumnDef::new(Providers::SortOrder).integer().not_null().default(0))
                    .col(ColumnDef::new(Providers::CreatedAt).integer().not_null())
                    .col(ColumnDef::new(Providers::UpdatedAt).integer().not_null())
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 2. Provider Keys
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(ProviderKeys::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(ProviderKeys::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(ProviderKeys::ProviderId).string().not_null())
                    .col(ColumnDef::new(ProviderKeys::KeyEncrypted).string().not_null())
                    .col(ColumnDef::new(ProviderKeys::KeyPrefix).string().not_null().default(""))
                    .col(ColumnDef::new(ProviderKeys::Enabled).integer().not_null().default(1))
                    .col(ColumnDef::new(ProviderKeys::LastValidatedAt).integer().null())
                    .col(ColumnDef::new(ProviderKeys::LastError).string().null())
                    .col(ColumnDef::new(ProviderKeys::RotationIndex).integer().not_null().default(0))
                    .col(ColumnDef::new(ProviderKeys::CreatedAt).integer().not_null())
                    .foreign_key(
                        ForeignKey::create()
                            .from(ProviderKeys::Table, ProviderKeys::ProviderId)
                            .to(Providers::Table, Providers::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 3. Models (composite primary key)
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(Models::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(Models::ProviderId).string().not_null())
                    .col(ColumnDef::new(Models::ModelId).string().not_null())
                    .col(ColumnDef::new(Models::Name).string().not_null())
                    .col(ColumnDef::new(Models::Capabilities).string().not_null().default("[]"))
                    .col(ColumnDef::new(Models::MaxTokens).integer().null())
                    .col(ColumnDef::new(Models::Enabled).integer().not_null().default(1))
                    .col(ColumnDef::new(Models::ParamOverrides).string().null())
                    .col(ColumnDef::new(Models::ModelType).string().not_null().default("chat"))
                    .col(ColumnDef::new(Models::GroupName).string().null())
                    .primary_key(
                        Index::create()
                            .col(Models::ProviderId)
                            .col(Models::ModelId),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(Models::Table, Models::ProviderId)
                            .to(Providers::Table, Providers::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 4. Conversations
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(Conversations::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(Conversations::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(Conversations::Title).string().not_null())
                    .col(ColumnDef::new(Conversations::ModelId).string().not_null())
                    .col(ColumnDef::new(Conversations::ProviderId).string().not_null())
                    .col(ColumnDef::new(Conversations::AppId).string().null())
                    .col(ColumnDef::new(Conversations::SystemPrompt).string().null())
                    .col(
                        ColumnDef::new(Conversations::Temperature)
                            .float()
                            .null()
                            .to_owned(),
                    )
                    .col(ColumnDef::new(Conversations::MaxTokens).integer().null())
                    .col(
                        ColumnDef::new(Conversations::TopP)
                            .float()
                            .null()
                            .to_owned(),
                    )
                    .col(
                        ColumnDef::new(Conversations::FrequencyPenalty)
                            .float()
                            .null()
                            .to_owned(),
                    )
                    .col(ColumnDef::new(Conversations::MessageCount).integer().not_null().default(0))
                    .col(ColumnDef::new(Conversations::IsPinned).integer().not_null().default(0))
                    .col(ColumnDef::new(Conversations::IsArchived).integer().not_null().default(0))
                    .col(ColumnDef::new(Conversations::WorkspaceSnapshotJson).string().not_null().default("{}"))
                    .col(ColumnDef::new(Conversations::ActiveBranchId).string().null())
                    .col(ColumnDef::new(Conversations::ActiveArtifactId).string().null())
                    .col(ColumnDef::new(Conversations::ResearchMode).integer().not_null().default(0))
                    .col(ColumnDef::new(Conversations::SearchEnabled).integer().not_null().default(0))
                    .col(ColumnDef::new(Conversations::SearchProviderId).string().null())
                    .col(ColumnDef::new(Conversations::ThinkingBudget).integer().null())
                    .col(ColumnDef::new(Conversations::EnabledMcpServerIds).string().not_null().default("[]"))
                    .col(ColumnDef::new(Conversations::EnabledKnowledgeBaseIds).string().not_null().default("[]"))
                    .col(ColumnDef::new(Conversations::EnabledMemoryNamespaceIds).string().not_null().default("[]"))
                    .col(ColumnDef::new(Conversations::CreatedAt).integer().not_null())
                    .col(ColumnDef::new(Conversations::UpdatedAt).integer().not_null())
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 5. Messages
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(Messages::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(Messages::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(Messages::ConversationId).string().not_null())
                    .col(ColumnDef::new(Messages::Role).string().not_null())
                    .col(ColumnDef::new(Messages::Content).string().not_null())
                    .col(ColumnDef::new(Messages::ProviderId).string().null())
                    .col(ColumnDef::new(Messages::ModelId).string().null())
                    .col(ColumnDef::new(Messages::TokenCount).integer().null())
                    .col(ColumnDef::new(Messages::Attachments).string().not_null().default("[]"))
                    .col(ColumnDef::new(Messages::Thinking).string().null())
                    .col(ColumnDef::new(Messages::ParentMessageId).string().null())
                    .col(ColumnDef::new(Messages::VersionIndex).integer().not_null().default(0))
                    .col(ColumnDef::new(Messages::IsActive).integer().not_null().default(1))
                    .col(ColumnDef::new(Messages::BranchId).string().null())
                    .col(ColumnDef::new(Messages::ToolCallsJson).string().null())
                    .col(ColumnDef::new(Messages::ToolCallId).string().null())
                    .col(ColumnDef::new(Messages::CreatedAt).integer().not_null())
                    .foreign_key(
                        ForeignKey::create()
                            .from(Messages::Table, Messages::ConversationId)
                            .to(Conversations::Table, Conversations::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 6. Categories
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(Categories::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(Categories::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(Categories::Name).string().not_null())
                    .col(ColumnDef::new(Categories::SortOrder).integer().not_null().default(0))
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 7. Apps
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(Apps::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(Apps::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(Apps::Name).string().not_null())
                    .col(ColumnDef::new(Apps::Description).string().not_null().default(""))
                    .col(ColumnDef::new(Apps::Icon).string().not_null().default("🤖"))
                    .col(ColumnDef::new(Apps::IconColor).string().not_null().default("#22c55e"))
                    .col(ColumnDef::new(Apps::SystemPrompt).string().not_null())
                    .col(ColumnDef::new(Apps::DefaultModelId).string().null())
                    .col(ColumnDef::new(Apps::DefaultProviderId).string().null())
                    .col(
                        ColumnDef::new(Apps::Temperature)
                            .float()
                            .null()
                            .to_owned(),
                    )
                    .col(ColumnDef::new(Apps::MaxTokens).integer().null())
                    .col(
                        ColumnDef::new(Apps::TopP)
                            .float()
                            .null()
                            .to_owned(),
                    )
                    .col(ColumnDef::new(Apps::CategoryId).string().null())
                    .col(ColumnDef::new(Apps::IsFavorite).integer().not_null().default(0))
                    .col(ColumnDef::new(Apps::Variables).string().not_null().default("[]"))
                    .col(ColumnDef::new(Apps::SearchPolicyJson).string().null())
                    .col(ColumnDef::new(Apps::ToolBindingJson).string().null())
                    .col(ColumnDef::new(Apps::KnowledgeBindingJson).string().null())
                    .col(ColumnDef::new(Apps::MemoryPolicyJson).string().null())
                    .col(ColumnDef::new(Apps::CreatedAt).integer().not_null())
                    .col(ColumnDef::new(Apps::UpdatedAt).integer().not_null())
                    .foreign_key(
                        ForeignKey::create()
                            .from(Apps::Table, Apps::CategoryId)
                            .to(Categories::Table, Categories::Id)
                            .on_delete(ForeignKeyAction::SetNull),
                    )
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 8. Gateway Keys
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(GatewayKeys::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(GatewayKeys::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(GatewayKeys::Name).string().not_null())
                    .col(
                        ColumnDef::new(GatewayKeys::KeyHash)
                            .string()
                            .not_null()
                            .unique_key()
                            .to_owned(),
                    )
                    .col(ColumnDef::new(GatewayKeys::KeyPrefix).string().not_null())
                    .col(ColumnDef::new(GatewayKeys::EncryptedKey).string().null())
                    .col(ColumnDef::new(GatewayKeys::Enabled).integer().not_null().default(1))
                    .col(ColumnDef::new(GatewayKeys::CreatedAt).integer().not_null())
                    .col(ColumnDef::new(GatewayKeys::LastUsedAt).integer().null())
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 9. Gateway Usage
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(GatewayUsage::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(GatewayUsage::Id)
                            .integer()
                            .not_null()
                            .auto_increment()
                            .primary_key()
                            .to_owned(),
                    )
                    .col(ColumnDef::new(GatewayUsage::KeyId).string().not_null())
                    .col(ColumnDef::new(GatewayUsage::ProviderId).string().not_null())
                    .col(ColumnDef::new(GatewayUsage::ModelId).string().null())
                    .col(ColumnDef::new(GatewayUsage::RequestTokens).integer().not_null().default(0))
                    .col(ColumnDef::new(GatewayUsage::ResponseTokens).integer().not_null().default(0))
                    .col(ColumnDef::new(GatewayUsage::CreatedAt).integer().not_null())
                    .foreign_key(
                        ForeignKey::create()
                            .from(GatewayUsage::Table, GatewayUsage::KeyId)
                            .to(GatewayKeys::Table, GatewayKeys::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 10. Settings
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(Settings::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(Settings::Key).string().not_null().primary_key())
                    .col(ColumnDef::new(Settings::Value).string().not_null())
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 11. Search Providers
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(SearchProviders::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(SearchProviders::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(SearchProviders::Name).string().not_null())
                    .col(ColumnDef::new(SearchProviders::ProviderType).string().not_null().default("tavily"))
                    .col(ColumnDef::new(SearchProviders::Endpoint).string().null())
                    .col(ColumnDef::new(SearchProviders::ApiKeyRef).string().null())
                    .col(ColumnDef::new(SearchProviders::Enabled).integer().not_null().default(1))
                    .col(ColumnDef::new(SearchProviders::Region).string().null())
                    .col(ColumnDef::new(SearchProviders::Language).string().null())
                    .col(ColumnDef::new(SearchProviders::SafeSearch).integer().null())
                    .col(ColumnDef::new(SearchProviders::ResultLimit).integer().not_null().default(10))
                    .col(ColumnDef::new(SearchProviders::TimeoutMs).integer().not_null().default(5000))
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_search_providers_enabled")
                    .table(SearchProviders::Table)
                    .col(SearchProviders::Enabled)
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 12. Search Citations
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(SearchCitations::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(SearchCitations::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(SearchCitations::ConversationId).string().not_null())
                    .col(ColumnDef::new(SearchCitations::MessageId).string().not_null())
                    .col(ColumnDef::new(SearchCitations::Title).string().not_null())
                    .col(ColumnDef::new(SearchCitations::Url).string().not_null())
                    .col(ColumnDef::new(SearchCitations::Snippet).string().null())
                    .col(ColumnDef::new(SearchCitations::ProviderId).string().not_null())
                    .col(ColumnDef::new(SearchCitations::Rank).integer().not_null().default(0))
                    .foreign_key(
                        ForeignKey::create()
                            .from(SearchCitations::Table, SearchCitations::ConversationId)
                            .to(Conversations::Table, Conversations::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_search_citations_conv")
                    .table(SearchCitations::Table)
                    .col(SearchCitations::ConversationId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_search_citations_msg")
                    .table(SearchCitations::Table)
                    .col(SearchCitations::MessageId)
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 13. MCP Servers
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(McpServers::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(McpServers::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(McpServers::Name).string().not_null())
                    .col(ColumnDef::new(McpServers::Transport).string().not_null().default("stdio"))
                    .col(ColumnDef::new(McpServers::Command).string().null())
                    .col(ColumnDef::new(McpServers::ArgsJson).string().null())
                    .col(ColumnDef::new(McpServers::Endpoint).string().null())
                    .col(ColumnDef::new(McpServers::EnvJson).string().null())
                    .col(ColumnDef::new(McpServers::Enabled).integer().not_null().default(1))
                    .col(ColumnDef::new(McpServers::PermissionPolicy).string().not_null().default("ask"))
                    .col(ColumnDef::new(McpServers::Source).string().not_null().default("custom"))
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_mcp_servers_enabled")
                    .table(McpServers::Table)
                    .col(McpServers::Enabled)
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 14. Tool Descriptors
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(ToolDescriptors::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(ToolDescriptors::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(ToolDescriptors::ServerId).string().not_null())
                    .col(ColumnDef::new(ToolDescriptors::Name).string().not_null())
                    .col(ColumnDef::new(ToolDescriptors::Description).string().null())
                    .col(ColumnDef::new(ToolDescriptors::InputSchemaJson).string().null())
                    .foreign_key(
                        ForeignKey::create()
                            .from(ToolDescriptors::Table, ToolDescriptors::ServerId)
                            .to(McpServers::Table, McpServers::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_tool_descriptors_server")
                    .table(ToolDescriptors::Table)
                    .col(ToolDescriptors::ServerId)
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 15. Tool Executions
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(ToolExecutions::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(ToolExecutions::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(ToolExecutions::ConversationId).string().not_null())
                    .col(ColumnDef::new(ToolExecutions::MessageId).string().null())
                    .col(ColumnDef::new(ToolExecutions::ServerId).string().not_null())
                    .col(ColumnDef::new(ToolExecutions::ToolName).string().not_null())
                    .col(ColumnDef::new(ToolExecutions::Status).string().not_null().default("pending"))
                    .col(ColumnDef::new(ToolExecutions::InputPreview).string().null())
                    .col(ColumnDef::new(ToolExecutions::OutputPreview).string().null())
                    .col(ColumnDef::new(ToolExecutions::ErrorMessage).string().null())
                    .col(ColumnDef::new(ToolExecutions::DurationMs).integer().null())
                    .col(
                        ColumnDef::new(ToolExecutions::CreatedAt)
                            .string()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(ToolExecutions::Table, ToolExecutions::ConversationId)
                            .to(Conversations::Table, Conversations::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_tool_executions_conv")
                    .table(ToolExecutions::Table)
                    .col(ToolExecutions::ConversationId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_tool_executions_msg")
                    .table(ToolExecutions::Table)
                    .col(ToolExecutions::MessageId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_tool_executions_server")
                    .table(ToolExecutions::Table)
                    .col(ToolExecutions::ServerId)
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 16. Knowledge Bases
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(KnowledgeBases::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(KnowledgeBases::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(KnowledgeBases::Name).string().not_null())
                    .col(ColumnDef::new(KnowledgeBases::Description).string().null())
                    .col(ColumnDef::new(KnowledgeBases::EmbeddingProvider).string().null())
                    .col(ColumnDef::new(KnowledgeBases::Enabled).integer().not_null().default(1))
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_knowledge_bases_enabled")
                    .table(KnowledgeBases::Table)
                    .col(KnowledgeBases::Enabled)
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 17. Knowledge Documents
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(KnowledgeDocuments::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(KnowledgeDocuments::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(KnowledgeDocuments::KnowledgeBaseId).string().not_null())
                    .col(ColumnDef::new(KnowledgeDocuments::Title).string().not_null())
                    .col(ColumnDef::new(KnowledgeDocuments::SourcePath).string().not_null())
                    .col(ColumnDef::new(KnowledgeDocuments::MimeType).string().not_null())
                    .col(ColumnDef::new(KnowledgeDocuments::SizeBytes).integer().not_null().default(0))
                    .col(ColumnDef::new(KnowledgeDocuments::IndexingStatus).string().not_null().default("pending"))
                    .foreign_key(
                        ForeignKey::create()
                            .from(
                                KnowledgeDocuments::Table,
                                KnowledgeDocuments::KnowledgeBaseId,
                            )
                            .to(KnowledgeBases::Table, KnowledgeBases::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_knowledge_documents_kb")
                    .table(KnowledgeDocuments::Table)
                    .col(KnowledgeDocuments::KnowledgeBaseId)
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 18. Retrieval Hits
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(RetrievalHits::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(RetrievalHits::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(RetrievalHits::ConversationId).string().not_null())
                    .col(ColumnDef::new(RetrievalHits::MessageId).string().not_null())
                    .col(ColumnDef::new(RetrievalHits::KnowledgeBaseId).string().not_null())
                    .col(ColumnDef::new(RetrievalHits::DocumentId).string().not_null())
                    .col(ColumnDef::new(RetrievalHits::ChunkRef).string().not_null())
                    .col(
                        ColumnDef::new(RetrievalHits::Score)
                            .float()
                            .not_null()
                            .default(0.0),
                    )
                    .col(ColumnDef::new(RetrievalHits::Preview).string().not_null())
                    .foreign_key(
                        ForeignKey::create()
                            .from(RetrievalHits::Table, RetrievalHits::ConversationId)
                            .to(Conversations::Table, Conversations::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(RetrievalHits::Table, RetrievalHits::KnowledgeBaseId)
                            .to(KnowledgeBases::Table, KnowledgeBases::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_retrieval_hits_conv")
                    .table(RetrievalHits::Table)
                    .col(RetrievalHits::ConversationId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_retrieval_hits_msg")
                    .table(RetrievalHits::Table)
                    .col(RetrievalHits::MessageId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_retrieval_hits_kb")
                    .table(RetrievalHits::Table)
                    .col(RetrievalHits::KnowledgeBaseId)
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 19. Memory Namespaces
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(MemoryNamespaces::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(MemoryNamespaces::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(MemoryNamespaces::Name).string().not_null())
                    .col(ColumnDef::new(MemoryNamespaces::Scope).string().not_null().default("global"))
                    .col(ColumnDef::new(MemoryNamespaces::AppId).string().null())
                    .col(ColumnDef::new(MemoryNamespaces::EmbeddingProvider).string().null())
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_memory_namespaces_scope")
                    .table(MemoryNamespaces::Table)
                    .col(MemoryNamespaces::Scope)
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 20. Memory Items
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(MemoryItems::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(MemoryItems::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(MemoryItems::NamespaceId).string().not_null())
                    .col(ColumnDef::new(MemoryItems::Title).string().not_null())
                    .col(ColumnDef::new(MemoryItems::Content).string().not_null())
                    .col(ColumnDef::new(MemoryItems::Source).string().not_null().default("manual"))
                    .col(
                        ColumnDef::new(MemoryItems::UpdatedAt)
                            .string()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(MemoryItems::Table, MemoryItems::NamespaceId)
                            .to(MemoryNamespaces::Table, MemoryNamespaces::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_memory_items_ns")
                    .table(MemoryItems::Table)
                    .col(MemoryItems::NamespaceId)
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 21. Artifacts
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(Artifacts::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(Artifacts::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(Artifacts::ConversationId).string().not_null())
                    .col(ColumnDef::new(Artifacts::Kind).string().not_null().default("draft"))
                    .col(ColumnDef::new(Artifacts::Title).string().not_null())
                    .col(ColumnDef::new(Artifacts::Content).string().not_null().default(""))
                    .col(ColumnDef::new(Artifacts::Format).string().not_null().default("markdown"))
                    .col(ColumnDef::new(Artifacts::Pinned).integer().not_null().default(0))
                    .col(
                        ColumnDef::new(Artifacts::UpdatedAt)
                            .string()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(Artifacts::Table, Artifacts::ConversationId)
                            .to(Conversations::Table, Conversations::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_artifacts_conv")
                    .table(Artifacts::Table)
                    .col(Artifacts::ConversationId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_artifacts_pinned")
                    .table(Artifacts::Table)
                    .col(Artifacts::Pinned)
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 22. Context Packs
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(ContextPacks::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(ContextPacks::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(ContextPacks::AppId).string().not_null())
                    .col(ColumnDef::new(ContextPacks::Name).string().not_null())
                    .col(ColumnDef::new(ContextPacks::Content).string().not_null().default(""))
                    .col(ColumnDef::new(ContextPacks::EnabledByDefault).integer().not_null().default(1))
                    .foreign_key(
                        ForeignKey::create()
                            .from(ContextPacks::Table, ContextPacks::AppId)
                            .to(Apps::Table, Apps::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_context_packs_app")
                    .table(ContextPacks::Table)
                    .col(ContextPacks::AppId)
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 23. Context Sources
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(ContextSources::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(ContextSources::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(ContextSources::ConversationId).string().not_null())
                    .col(ColumnDef::new(ContextSources::MessageId).string().null())
                    .col(ColumnDef::new(ContextSources::SourceType).string().not_null())
                    .col(ColumnDef::new(ContextSources::RefId).string().not_null())
                    .col(ColumnDef::new(ContextSources::Title).string().not_null())
                    .col(ColumnDef::new(ContextSources::Enabled).integer().not_null().default(1))
                    .col(ColumnDef::new(ContextSources::Summary).string().null())
                    .foreign_key(
                        ForeignKey::create()
                            .from(ContextSources::Table, ContextSources::ConversationId)
                            .to(Conversations::Table, Conversations::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_context_sources_conv")
                    .table(ContextSources::Table)
                    .col(ContextSources::ConversationId)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_context_sources_msg")
                    .table(ContextSources::Table)
                    .col(ContextSources::MessageId)
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 24. Conversation Branches
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(ConversationBranches::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(ConversationBranches::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(ConversationBranches::ConversationId).string().not_null())
                    .col(ColumnDef::new(ConversationBranches::ParentMessageId).string().not_null())
                    .col(ColumnDef::new(ConversationBranches::BranchLabel).string().not_null())
                    .col(ColumnDef::new(ConversationBranches::BranchIndex).integer().not_null().default(0))
                    .col(ColumnDef::new(ConversationBranches::ComparedMessageIdsJson).string().null())
                    .col(
                        ColumnDef::new(ConversationBranches::CreatedAt)
                            .string()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(
                                ConversationBranches::Table,
                                ConversationBranches::ConversationId,
                            )
                            .to(Conversations::Table, Conversations::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_conv_branches_parent")
                    .table(ConversationBranches::Table)
                    .col(ConversationBranches::ParentMessageId)
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 25. Backup Manifests
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(BackupManifests::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(BackupManifests::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(BackupManifests::Version).string().not_null())
                    .col(
                        ColumnDef::new(BackupManifests::CreatedAt)
                            .string()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .col(ColumnDef::new(BackupManifests::Encrypted).integer().not_null().default(0))
                    .col(ColumnDef::new(BackupManifests::Checksum).string().not_null())
                    .col(ColumnDef::new(BackupManifests::ObjectCountsJson).string().not_null().default("{}"))
                    .col(ColumnDef::new(BackupManifests::SourceAppVersion).string().not_null())
                    .col(ColumnDef::new(BackupManifests::FilePath).string().null())
                    .col(ColumnDef::new(BackupManifests::FileSize).big_integer().not_null().default(0))
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 26. Backup Targets
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(BackupTargets::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(BackupTargets::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(BackupTargets::Kind).string().not_null().default("local"))
                    .col(ColumnDef::new(BackupTargets::ConfigJson).string().not_null().default("{}"))
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_backup_targets_kind")
                    .table(BackupTargets::Table)
                    .col(BackupTargets::Kind)
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 27. Import Jobs
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(ImportJobs::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(ImportJobs::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(ImportJobs::SourceType).string().not_null())
                    .col(ColumnDef::new(ImportJobs::Status).string().not_null().default("scanning"))
                    .col(ColumnDef::new(ImportJobs::SummaryJson).string().null())
                    .col(ColumnDef::new(ImportJobs::ConflictCount).integer().not_null().default(0))
                    .col(
                        ColumnDef::new(ImportJobs::CreatedAt)
                            .string()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_import_jobs_status")
                    .table(ImportJobs::Table)
                    .col(ImportJobs::Status)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_import_jobs_created")
                    .table(ImportJobs::Table)
                    .col(ImportJobs::CreatedAt)
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 28. Program Policies
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(ProgramPolicies::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(ProgramPolicies::Id).string().not_null().primary_key())
                    .col(
                        ColumnDef::new(ProgramPolicies::ProgramName)
                            .string()
                            .not_null()
                            .unique_key(),
                    )
                    .col(ColumnDef::new(ProgramPolicies::AllowedProviderIdsJson).string().not_null().default("[]"))
                    .col(ColumnDef::new(ProgramPolicies::AllowedModelIdsJson).string().not_null().default("[]"))
                    .col(ColumnDef::new(ProgramPolicies::DefaultProviderId).string().null())
                    .col(ColumnDef::new(ProgramPolicies::DefaultModelId).string().null())
                    .col(ColumnDef::new(ProgramPolicies::RateLimitPerMinute).integer().null())
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_program_policies_name")
                    .table(ProgramPolicies::Table)
                    .col(ProgramPolicies::ProgramName)
                    .unique()
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 29. Gateway Diagnostics
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(GatewayDiagnostics::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(GatewayDiagnostics::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(GatewayDiagnostics::Category).string().not_null())
                    .col(ColumnDef::new(GatewayDiagnostics::Status).string().not_null().default("ok"))
                    .col(ColumnDef::new(GatewayDiagnostics::Message).string().not_null())
                    .col(
                        ColumnDef::new(GatewayDiagnostics::CreatedAt)
                            .string()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_gateway_diagnostics_cat")
                    .table(GatewayDiagnostics::Table)
                    .col(GatewayDiagnostics::Category)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_gateway_diagnostics_created")
                    .table(GatewayDiagnostics::Table)
                    .col(GatewayDiagnostics::CreatedAt)
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 30. Desktop State
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(DesktopState::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(DesktopState::WindowKey).string().not_null().primary_key())
                    .col(ColumnDef::new(DesktopState::Width).integer().not_null().default(1200))
                    .col(ColumnDef::new(DesktopState::Height).integer().not_null().default(800))
                    .col(ColumnDef::new(DesktopState::X).integer().null())
                    .col(ColumnDef::new(DesktopState::Y).integer().null())
                    .col(ColumnDef::new(DesktopState::Maximized).integer().not_null().default(0))
                    .col(ColumnDef::new(DesktopState::Visible).integer().not_null().default(1))
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 31. Stored Files
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(StoredFiles::Table)
                    .if_not_exists()
                    .col(ColumnDef::new(StoredFiles::Id).string().not_null().primary_key())
                    .col(ColumnDef::new(StoredFiles::Hash).string().not_null())
                    .col(ColumnDef::new(StoredFiles::OriginalName).string().not_null())
                    .col(
                        ColumnDef::new(StoredFiles::MimeType)
                            .string()
                            .not_null()
                            .default("application/octet-stream"),
                    )
                    .col(ColumnDef::new(StoredFiles::SizeBytes).integer().not_null())
                    .col(ColumnDef::new(StoredFiles::StoragePath).string().not_null())
                    .col(ColumnDef::new(StoredFiles::ConversationId).string().null())
                    .col(
                        ColumnDef::new(StoredFiles::CreatedAt)
                            .string()
                            .not_null()
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .from(StoredFiles::Table, StoredFiles::ConversationId)
                            .to(Conversations::Table, Conversations::Id)
                            .on_delete(ForeignKeyAction::SetNull),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_stored_files_hash")
                    .table(StoredFiles::Table)
                    .col(StoredFiles::Hash)
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .if_not_exists()
                    .name("idx_stored_files_conversation")
                    .table(StoredFiles::Table)
                    .col(StoredFiles::ConversationId)
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // 32. Gateway Request Logs
        // =================================================================
        manager
            .create_table(
                Table::create()
                    .table(GatewayRequestLogs::Table)
                    .if_not_exists()
                    .col(
                        ColumnDef::new(GatewayRequestLogs::Id)
                            .string()
                            .not_null()
                            .primary_key(),
                    )
                    .col(ColumnDef::new(GatewayRequestLogs::KeyId).string().not_null())
                    .col(ColumnDef::new(GatewayRequestLogs::KeyName).string().not_null())
                    .col(ColumnDef::new(GatewayRequestLogs::Method).string().not_null())
                    .col(ColumnDef::new(GatewayRequestLogs::Path).string().not_null())
                    .col(ColumnDef::new(GatewayRequestLogs::Model).string().null())
                    .col(ColumnDef::new(GatewayRequestLogs::ProviderId).string().null())
                    .col(ColumnDef::new(GatewayRequestLogs::StatusCode).integer().not_null())
                    .col(ColumnDef::new(GatewayRequestLogs::DurationMs).integer().not_null())
                    .col(
                        ColumnDef::new(GatewayRequestLogs::RequestTokens)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(
                        ColumnDef::new(GatewayRequestLogs::ResponseTokens)
                            .integer()
                            .not_null()
                            .default(0),
                    )
                    .col(ColumnDef::new(GatewayRequestLogs::ErrorMessage).string().null())
                    .col(ColumnDef::new(GatewayRequestLogs::CreatedAt).integer().not_null())
                    .to_owned(),
            )
            .await?;

        // =================================================================
        // FTS5 virtual table and triggers (raw SQL for SQLite-specific features)
        // =================================================================
        let db = manager.get_connection();

        db.execute_unprepared(
            "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(\
                content, \
                content=messages, \
                content_rowid=rowid, \
                tokenize='unicode61'\
            )",
        )
        .await?;

        db.execute_unprepared(
            "CREATE TRIGGER IF NOT EXISTS messages_ai AFTER INSERT ON messages BEGIN \
                INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content); \
            END",
        )
        .await?;

        db.execute_unprepared(
            "CREATE TRIGGER IF NOT EXISTS messages_ad AFTER DELETE ON messages BEGIN \
                INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content); \
            END",
        )
        .await?;

        db.execute_unprepared(
            "CREATE TRIGGER IF NOT EXISTS messages_au AFTER UPDATE OF content ON messages BEGIN \
                INSERT INTO messages_fts(messages_fts, rowid, content) VALUES('delete', old.rowid, old.content); \
                INSERT INTO messages_fts(rowid, content) VALUES (new.rowid, new.content); \
            END",
        )
        .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // Drop triggers and FTS5 table first
        let db = manager.get_connection();
        db.execute_unprepared("DROP TRIGGER IF EXISTS messages_au")
            .await?;
        db.execute_unprepared("DROP TRIGGER IF EXISTS messages_ad")
            .await?;
        db.execute_unprepared("DROP TRIGGER IF EXISTS messages_ai")
            .await?;
        db.execute_unprepared("DROP TABLE IF EXISTS messages_fts")
            .await?;

        // Drop tables in reverse creation order
        macro_rules! drop_tbl {
            ($t:expr) => {
                manager
                    .drop_table(Table::drop().table($t).if_exists().to_owned())
                    .await?;
            };
        }
        drop_tbl!(GatewayRequestLogs::Table);
        drop_tbl!(StoredFiles::Table);
        drop_tbl!(DesktopState::Table);
        drop_tbl!(GatewayDiagnostics::Table);
        drop_tbl!(ProgramPolicies::Table);
        drop_tbl!(ImportJobs::Table);
        drop_tbl!(BackupTargets::Table);
        drop_tbl!(BackupManifests::Table);
        drop_tbl!(ConversationBranches::Table);
        drop_tbl!(ContextSources::Table);
        drop_tbl!(ContextPacks::Table);
        drop_tbl!(Artifacts::Table);
        drop_tbl!(MemoryItems::Table);
        drop_tbl!(MemoryNamespaces::Table);
        drop_tbl!(RetrievalHits::Table);
        drop_tbl!(KnowledgeDocuments::Table);
        drop_tbl!(KnowledgeBases::Table);
        drop_tbl!(ToolExecutions::Table);
        drop_tbl!(ToolDescriptors::Table);
        drop_tbl!(McpServers::Table);
        drop_tbl!(SearchCitations::Table);
        drop_tbl!(SearchProviders::Table);
        drop_tbl!(Settings::Table);
        drop_tbl!(GatewayUsage::Table);
        drop_tbl!(GatewayKeys::Table);
        drop_tbl!(Apps::Table);
        drop_tbl!(Categories::Table);
        drop_tbl!(Messages::Table);
        drop_tbl!(Conversations::Table);
        drop_tbl!(Models::Table);
        drop_tbl!(ProviderKeys::Table);
        drop_tbl!(Providers::Table);

        Ok(())
    }
}
