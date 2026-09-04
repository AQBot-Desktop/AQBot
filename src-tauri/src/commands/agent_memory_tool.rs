use aqbot_core::context_engine::{execute_memory_tool, memory_tool_definition, MemoryToolScope, MEMORY_TOOL_NAME};
use async_trait::async_trait;
use open_agent_sdk::types::{Tool, ToolError, ToolInputSchema, ToolResult, ToolUseContext};
use sea_orm::DatabaseConnection;
use serde_json::Value;

pub(crate) struct AgentMemoryTool {
    db: DatabaseConnection,
    scope: MemoryToolScope,
    description: String,
    input_schema: Value,
}

impl AgentMemoryTool {
    pub(crate) fn new(db: DatabaseConnection, scope: MemoryToolScope) -> Self {
        let definition = memory_tool_definition();
        let input_schema = definition.function.parameters.unwrap_or_else(|| {
            serde_json::to_value(ToolInputSchema::default())
                .expect("ToolInputSchema must always serialize to JSON")
        });
        Self {
            db,
            scope,
            description: definition
                .function
                .description
                .unwrap_or_else(|| "Read bound memory notebooks".to_string()),
            input_schema,
        }
    }
}

#[async_trait]
impl Tool for AgentMemoryTool {
    fn name(&self) -> &str {
        MEMORY_TOOL_NAME
    }

    fn description(&self) -> &str {
        &self.description
    }

    fn input_schema(&self) -> ToolInputSchema {
        serde_json::from_value(self.input_schema.clone()).unwrap_or_default()
    }

    fn input_schema_json(&self) -> Value {
        self.input_schema.clone()
    }

    fn is_read_only(&self, _input: &Value) -> bool {
        true
    }

    async fn call(&self, input: Value, context: &ToolUseContext) -> Result<ToolResult, ToolError> {
        if context.abort_signal.is_cancelled() {
            return Err(ToolError::Aborted);
        }
        match execute_memory_tool(&self.db, &self.scope, input).await {
            Ok(text) => Ok(ToolResult::text(text)),
            Err(error) => Ok(ToolResult::error(error.to_string())),
        }
    }
}
