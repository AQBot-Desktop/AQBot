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
        "exa" => "https://api.exa.ai/search",
        "youcom" => "https://ydc-index.io/v1/search",
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
        "exa" => search_exa(endpoint, api_key, query, max_results, timeout_ms).await,
        "youcom" => search_youcom(endpoint, api_key, query, max_results, timeout_ms).await,
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

// ── Exa ─────────────────────────────────────────────────
// POST {endpoint}
// Header: x-api-key: {apiKey}
// Body: { query, numResults, type: "auto", contents: { highlights: true } }
// Response: { results: [{ title, url, highlights, summary, text }] }

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ExaRequest<'a> {
    query: &'a str,
    num_results: i32,
    #[serde(rename = "type")]
    search_type: &'a str,
    contents: ExaContents,
}

#[derive(Serialize)]
struct ExaContents {
    highlights: bool,
}

#[derive(Deserialize)]
struct ExaResponse {
    results: Vec<ExaResult>,
}

#[derive(Deserialize)]
struct ExaResult {
    title: Option<String>,
    url: Option<String>,
    highlights: Option<Vec<String>>,
    summary: Option<String>,
    text: Option<String>,
}

fn exa_result_content(r: &ExaResult) -> String {
    r.highlights
        .as_ref()
        .filter(|highlights| !highlights.is_empty())
        .map(|highlights| highlights.join("\n\n"))
        .or_else(|| r.summary.clone())
        .or_else(|| r.text.clone())
        .unwrap_or_default()
}

fn exa_result_to_search_result(r: ExaResult) -> SearchResult {
    let content = exa_result_content(&r);
    SearchResult {
        title: r.title.unwrap_or_else(|| "No title".to_string()),
        content,
        url: r.url.unwrap_or_default(),
    }
}

async fn search_exa(
    endpoint: Option<&str>,
    api_key: &str,
    query: &str,
    max_results: i32,
    timeout_ms: i32,
) -> Result<Vec<SearchResult>> {
    let url = endpoint.unwrap_or("https://api.exa.ai/search");

    let client = Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms as u64))
        .build()
        .map_err(|e| AQBotError::Provider(format!("HTTP client error: {e}")))?;

    let body = ExaRequest {
        query,
        num_results: max_results.clamp(1, 100),
        search_type: "auto",
        contents: ExaContents { highlights: true },
    };

    let resp = client
        .post(url)
        .header("x-api-key", api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AQBotError::Provider(format!("Exa request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AQBotError::Provider(format!(
            "Exa API error {status}: {text}"
        )));
    }

    let data: ExaResponse = resp
        .json()
        .await
        .map_err(|e| AQBotError::Provider(format!("Exa response parse error: {e}")))?;

    Ok(data
        .results
        .into_iter()
        .take(max_results.max(1) as usize)
        .map(exa_result_to_search_result)
        .collect())
}

// ── You.com ─────────────────────────────────────────────
// POST {endpoint}
// Header: X-API-Key: {apiKey}
// Body: { query, count }
// Response: { results: { web: [{ title, url, description, snippets }] } }

#[derive(Serialize)]
struct YoucomRequest<'a> {
    query: &'a str,
    count: i32,
}

#[derive(Deserialize)]
struct YoucomResponse {
    #[serde(default)]
    results: YoucomSections,
}

#[derive(Deserialize, Default)]
struct YoucomSections {
    #[serde(default)]
    web: Vec<YoucomResult>,
}

#[derive(Deserialize)]
struct YoucomResult {
    title: Option<String>,
    url: Option<String>,
    description: Option<String>,
    snippets: Option<Vec<String>>,
}

fn youcom_result_content(r: &YoucomResult) -> String {
    r.snippets
        .as_ref()
        .filter(|snippets| !snippets.is_empty())
        .map(|snippets| snippets.join("\n\n"))
        .or_else(|| r.description.clone())
        .unwrap_or_default()
}

fn youcom_result_to_search_result(r: YoucomResult) -> SearchResult {
    let content = youcom_result_content(&r);
    SearchResult {
        title: r.title.unwrap_or_else(|| "No title".to_string()),
        content,
        url: r.url.unwrap_or_default(),
    }
}

async fn search_youcom(
    endpoint: Option<&str>,
    api_key: &str,
    query: &str,
    max_results: i32,
    timeout_ms: i32,
) -> Result<Vec<SearchResult>> {
    let url = endpoint.unwrap_or("https://ydc-index.io/v1/search");

    let client = Client::builder()
        .timeout(std::time::Duration::from_millis(timeout_ms as u64))
        .build()
        .map_err(|e| AQBotError::Provider(format!("HTTP client error: {e}")))?;

    let body = YoucomRequest {
        query,
        count: max_results.clamp(1, 20),
    };

    let resp = client
        .post(url)
        .header("X-API-Key", api_key)
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| AQBotError::Provider(format!("You.com request failed: {e}")))?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(AQBotError::Provider(format!(
            "You.com API error {status}: {text}"
        )));
    }

    let data: YoucomResponse = resp
        .json()
        .await
        .map_err(|e| AQBotError::Provider(format!("You.com response parse error: {e}")))?;

    Ok(data
        .results
        .web
        .into_iter()
        .take(max_results.max(1) as usize)
        .map(youcom_result_to_search_result)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn exa_request_serializes_current_payload() {
        let body = ExaRequest {
            query: "latest docs",
            num_results: 2,
            search_type: "auto",
            contents: ExaContents { highlights: true },
        };

        assert_eq!(
            serde_json::to_value(body).unwrap(),
            json!({
                "query": "latest docs",
                "numResults": 2,
                "type": "auto",
                "contents": { "highlights": true }
            })
        );
    }

    #[test]
    fn exa_result_maps_highlights() {
        let result = exa_result_to_search_result(ExaResult {
            title: Some("Doc".into()),
            url: Some("https://example.com/doc".into()),
            highlights: Some(vec!["first".into(), "second".into()]),
            summary: Some("summary".into()),
            text: Some("text".into()),
        });

        assert_eq!(result.title, "Doc");
        assert_eq!(result.url, "https://example.com/doc");
        assert_eq!(result.content, "first\n\nsecond");
    }

    #[test]
    fn exa_result_falls_back_to_summary_then_text() {
        let summary = ExaResult {
            title: None,
            url: None,
            highlights: Some(vec![]),
            summary: Some("summary content".into()),
            text: Some("text content".into()),
        };
        let text = ExaResult {
            title: None,
            url: None,
            highlights: None,
            summary: None,
            text: Some("text content".into()),
        };

        assert_eq!(exa_result_content(&summary), "summary content");
        assert_eq!(exa_result_content(&text), "text content");
    }

    #[test]
    fn youcom_request_serializes_current_payload() {
        let body = YoucomRequest {
            query: "rust tauri guide",
            count: 5,
        };

        assert_eq!(
            serde_json::to_value(body).unwrap(),
            json!({
                "query": "rust tauri guide",
                "count": 5
            })
        );
    }

    #[test]
    fn youcom_result_maps_snippets() {
        let result = youcom_result_to_search_result(YoucomResult {
            title: Some("Guide".into()),
            url: Some("https://example.com/guide".into()),
            description: Some("description".into()),
            snippets: Some(vec!["first".into(), "second".into()]),
        });

        assert_eq!(result.title, "Guide");
        assert_eq!(result.url, "https://example.com/guide");
        assert_eq!(result.content, "first\n\nsecond");
    }

    #[test]
    fn youcom_result_falls_back_to_description_then_empty() {
        let description = YoucomResult {
            title: None,
            url: None,
            description: Some("description content".into()),
            snippets: Some(vec![]),
        };
        let empty = YoucomResult {
            title: None,
            url: None,
            description: None,
            snippets: None,
        };

        assert_eq!(youcom_result_content(&description), "description content");
        assert_eq!(youcom_result_content(&empty), "");
    }

    #[test]
    fn youcom_response_parses_web_section() {
        let payload = json!({
            "results": {
                "web": [
                    { "title": "Doc", "url": "https://example.com/doc", "description": "d", "snippets": ["s1"] }
                ]
            }
        });

        let data: YoucomResponse = serde_json::from_value(payload).unwrap();
        let results: Vec<SearchResult> = data
            .results
            .web
            .into_iter()
            .map(youcom_result_to_search_result)
            .collect();

        assert_eq!(results.len(), 1);
        assert_eq!(results[0].title, "Doc");
        assert_eq!(results[0].url, "https://example.com/doc");
        assert_eq!(results[0].content, "s1");
    }

    #[test]
    fn youcom_response_tolerates_missing_sections() {
        let data: YoucomResponse = serde_json::from_value(json!({})).unwrap();
        assert!(data.results.web.is_empty());
    }
}
