use std::time::Instant;

use reqwest::Client;
use serde::{Deserialize, Serialize};

use crate::error::{AQBotError, Result};

// ── Response types ────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub title: String,
    pub content: String,
    pub url: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub ok: bool,
    pub query: String,
    pub results: Vec<SearchResult>,
    pub latency_ms: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

// ── Default endpoints ─────────────────────────────────────

pub fn default_endpoint(provider_type: &str) -> &'static str {
    match provider_type {
        "tavily" => "https://api.tavily.com/search",
        "zhipu" => "https://open.bigmodel.cn/api/paas/v4/web_search",
        "bocha" => "https://api.bochaai.com/v1/web-search",
        _ => "",
    }
}

// ── Main search dispatch ──────────────────────────────────

pub async fn execute_search(
    provider_type: &str,
    endpoint: Option<&str>,
    api_key: &str,
    query: &str,
    max_results: i32,
    timeout_ms: i32,
) -> Result<SearchResponse> {
    let start = Instant::now();

    let result = match provider_type {
        "tavily" => search_tavily(endpoint, api_key, query, max_results, timeout_ms).await,
        "zhipu" => search_zhipu(endpoint, api_key, query, max_results, timeout_ms).await,
        "bocha" => search_bocha(endpoint, api_key, query, max_results, timeout_ms).await,
        _ => {
            return Err(AQBotError::Validation(format!(
                "Unsupported provider type: {}",
                provider_type
            )));
        }
    };

    let latency = start.elapsed().as_millis() as u64;

    match result {
        Ok(results) => Ok(SearchResponse {
            ok: true,
            query: query.to_string(),
            results,
            latency_ms: latency,
            error: None,
        }),
        Err(e) => Ok(SearchResponse {
            ok: false,
            query: query.to_string(),
            results: vec![],
            latency_ms: latency,
            error: Some(e.to_string()),
        }),
    }
}

pub async fn test_provider(
    provider_type: &str,
    endpoint: Option<&str>,
    api_key: &str,
    timeout_ms: i32,
) -> TestResult {
    let resp = execute_search(provider_type, endpoint, api_key, "test", 3, timeout_ms).await;
    match resp {
        Ok(r) if r.ok => TestResult {
            ok: true,
            latency_ms: Some(r.latency_ms),
            result_count: Some(r.results.len()),
            error: None,
        },
        Ok(r) => TestResult {
            ok: false,
            latency_ms: Some(r.latency_ms),
            result_count: None,
            error: r.error,
        },
        Err(e) => TestResult {
            ok: false,
            latency_ms: None,
            result_count: None,
            error: Some(e.to_string()),
        },
    }
}

// ── Tavily ────────────────────────────────────────────────
// POST {endpoint}
// Body: { api_key, query, max_results }
// Response: { results: [{ title, content, url }] }

#[derive(Serialize)]
struct TavilyRequest<'a> {
    api_key: &'a str,
    query: &'a str,
    max_results: i32,
}

#[derive(Deserialize)]
struct TavilyResponse {
    results: Vec<TavilyResult>,
}

#[derive(Deserialize)]
struct TavilyResult {
    title: Option<String>,
    content: Option<String>,
    url: Option<String>,
}

async fn search_tavily(
    endpoint: Option<&str>,
    api_key: &str,
    query: &str,
    max_results: i32,
    timeout_ms: i32,
) -> Result<Vec<SearchResult>> {
    let url = endpoint.unwrap_or("https://api.tavily.com/search");

    let client = Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms as u64))
        .build()
        .map_err(|e| AQBotError::Provider(format!("HTTP client error: {e}")))?;

    let body = TavilyRequest {
        api_key,
        query,
        max_results: max_results.max(1),
    };

    let resp = client
        .post(url)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AQBotError::Provider(format!("Tavily request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AQBotError::Provider(format!(
            "Tavily API error {status}: {text}"
        )));
    }

    let data: TavilyResponse = resp
        .json()
        .await
        .map_err(|e| AQBotError::Provider(format!("Tavily response parse error: {e}")))?;

    Ok(data
        .results
        .into_iter()
        .take(max_results as usize)
        .map(|r| SearchResult {
            title: r.title.unwrap_or_else(|| "No title".to_string()),
            content: r.content.unwrap_or_default(),
            url: r.url.unwrap_or_default(),
        })
        .collect())
}

// ── Zhipu (智谱) ─────────────────────────────────────────
// POST {endpoint}
// Header: Authorization: Bearer {apiKey}
// Body: { search_query, search_engine: "search_std" }
// Response: { search_result: [{ title, content, link }] }

#[derive(Serialize)]
struct ZhipuRequest<'a> {
    search_query: &'a str,
    search_engine: &'a str,
}

#[derive(Deserialize)]
struct ZhipuResponse {
    search_result: Option<Vec<ZhipuResult>>,
}

#[derive(Deserialize)]
struct ZhipuResult {
    title: Option<String>,
    content: Option<String>,
    link: Option<String>,
}

async fn search_zhipu(
    endpoint: Option<&str>,
    api_key: &str,
    query: &str,
    max_results: i32,
    timeout_ms: i32,
) -> Result<Vec<SearchResult>> {
    let url = endpoint.unwrap_or("https://open.bigmodel.cn/api/paas/v4/web_search");

    let client = Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms as u64))
        .build()
        .map_err(|e| AQBotError::Provider(format!("HTTP client error: {e}")))?;

    let body = ZhipuRequest {
        search_query: query,
        search_engine: "search_std",
    };

    let resp = client
        .post(url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AQBotError::Provider(format!("Zhipu request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AQBotError::Provider(format!(
            "Zhipu API error {status}: {text}"
        )));
    }

    let data: ZhipuResponse = resp
        .json()
        .await
        .map_err(|e| AQBotError::Provider(format!("Zhipu response parse error: {e}")))?;

    let results = data.search_result.unwrap_or_default();
    Ok(results
        .into_iter()
        .take(max_results as usize)
        .map(|r| SearchResult {
            title: r.title.unwrap_or_else(|| "No title".to_string()),
            content: r.content.unwrap_or_default(),
            url: r.link.unwrap_or_default(),
        })
        .collect())
}

// ── Bocha (博查) ──────────────────────────────────────────
// POST {endpoint}
// Header: Authorization: Bearer {apiKey}
// Body: { query, count, summary: true, page: 1 }
// Response: { code, data: { webPages: { value: [{ name, url, snippet, summary }] } } }

#[derive(Serialize)]
struct BochaRequest<'a> {
    query: &'a str,
    count: i32,
    summary: bool,
    page: i32,
}

#[derive(Deserialize)]
struct BochaResponse {
    code: Option<i32>,
    msg: Option<String>,
    data: Option<BochaData>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BochaData {
    web_pages: Option<BochaWebPages>,
}

#[derive(Deserialize)]
struct BochaWebPages {
    value: Option<Vec<BochaWebResult>>,
}

#[derive(Deserialize)]
struct BochaWebResult {
    name: Option<String>,
    url: Option<String>,
    snippet: Option<String>,
    summary: Option<String>,
}

async fn search_bocha(
    endpoint: Option<&str>,
    api_key: &str,
    query: &str,
    max_results: i32,
    timeout_ms: i32,
) -> Result<Vec<SearchResult>> {
    let url = endpoint.unwrap_or("https://api.bochaai.com/v1/web-search");

    let client = Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms as u64))
        .build()
        .map_err(|e| AQBotError::Provider(format!("HTTP client error: {e}")))?;

    let body = BochaRequest {
        query,
        count: max_results.max(1),
        summary: true,
        page: 1,
    };

    let resp = client
        .post(url)
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AQBotError::Provider(format!("Bocha request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AQBotError::Provider(format!(
            "Bocha API error {status}: {text}"
        )));
    }

    let data: BochaResponse = resp
        .json()
        .await
        .map_err(|e| AQBotError::Provider(format!("Bocha response parse error: {e}")))?;

    if data.code.unwrap_or(0) != 200 {
        return Err(AQBotError::Provider(format!(
            "Bocha search failed: {}",
            data.msg.unwrap_or_else(|| "Unknown error".to_string())
        )));
    }

    let results = data
        .data
        .and_then(|d| d.web_pages)
        .and_then(|wp| wp.value)
        .unwrap_or_default();

    Ok(results
        .into_iter()
        .take(max_results as usize)
        .map(|r| SearchResult {
            title: r.name.unwrap_or_else(|| "No title".to_string()),
            content: r.summary.or(r.snippet).unwrap_or_default(),
            url: r.url.unwrap_or_default(),
        })
        .collect())
}
