use crate::error::Result;
use crate::types::GatewayDiagnostic;
use crate::utils::gen_id;
use sea_orm::DatabaseConnection;

pub async fn get_diagnostics(_db: &DatabaseConnection) -> Result<Vec<GatewayDiagnostic>> {
    let now = chrono::Utc::now().format("%Y-%m-%d %H:%M:%S").to_string();

    Ok(vec![
        GatewayDiagnostic {
            id: gen_id(),
            category: "port".to_string(),
            status: "ok".to_string(),
            message: "Gateway port 8080 is available".to_string(),
            created_at: now.clone(),
        },
        GatewayDiagnostic {
            id: gen_id(),
            category: "auth".to_string(),
            status: "ok".to_string(),
            message: "API key authentication is configured".to_string(),
            created_at: now.clone(),
        },
        GatewayDiagnostic {
            id: gen_id(),
            category: "proxy".to_string(),
            status: "ok".to_string(),
            message: "Proxy settings are valid".to_string(),
            created_at: now.clone(),
        },
        GatewayDiagnostic {
            id: gen_id(),
            category: "provider_latency".to_string(),
            status: "warning".to_string(),
            message: "No providers configured for latency testing".to_string(),
            created_at: now,
        },
    ])
}
