use std::io::Write;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

use aqbot_core::embedding::{
    artifact_file_path, huggingface_file_url, inspect_artifact, inspect_file, partial_path,
    publish_partial, uninstall_artifact, EmbeddingArtifactStatus, MULTILINGUAL_E5_SMALL_INT8,
};
use futures::StreamExt;
use tauri::{AppHandle, Emitter, State};

use crate::paths::aqbot_home;
use crate::AppState;

struct InstallJob {
    cancel: Arc<AtomicBool>,
}

static INSTALL_JOB: OnceLock<Mutex<Option<InstallJob>>> = OnceLock::new();

fn install_job() -> &'static Mutex<Option<InstallJob>> {
    INSTALL_JOB.get_or_init(|| Mutex::new(None))
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactProgress {
    status: String,
    downloaded_bytes: u64,
    total_bytes: u64,
}

#[tauri::command]
pub async fn get_embedding_artifact_status() -> Result<EmbeddingArtifactStatus, String> {
    let mut status = inspect_artifact(&aqbot_home());
    if let Ok(guard) = install_job().lock() {
        if guard.is_some() && status.status == "missing" {
            status.status = "downloading".into();
        }
    }
    Ok(status)
}

#[tauri::command]
pub async fn cancel_embedding_artifact_install() -> Result<(), String> {
    if let Ok(guard) = install_job().lock() {
        if let Some(job) = guard.as_ref() {
            job.cancel.store(true, Ordering::SeqCst);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn install_embedding_artifact(
    app: AppHandle,
    _state: State<'_, AppState>,
) -> Result<EmbeddingArtifactStatus, String> {
    let current = inspect_artifact(&aqbot_home());
    if current.status == "installed" {
        return Ok(current);
    }

    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut guard = install_job()
            .lock()
            .map_err(|_| "embedding install lock poisoned")?;
        if guard.is_some() {
            return Err(aqbot_core::error::coded_error(
                "EMBEDDING_ARTIFACT_BUSY",
                serde_json::json!({}),
            )
            .to_string());
        }
        *guard = Some(InstallJob {
            cancel: cancel.clone(),
        });
    }

    let app_for_task = app.clone();
    tokio::spawn(async move {
        let result = run_install(app_for_task.clone(), cancel).await;
        if let Ok(mut guard) = install_job().lock() {
            *guard = None;
        }
        let status = match result {
            Ok(()) => inspect_artifact(&aqbot_home()),
            Err(error) => {
                tracing::error!("embedding artifact install failed: {error}");
                let mut status = inspect_artifact(&aqbot_home());
                if status.status == "missing" {
                    status.status = "failed".into();
                }
                status
            }
        };
        let _ = app_for_task.emit(
            "embedding-artifact-progress",
            ArtifactProgress {
                status: status.status.clone(),
                downloaded_bytes: status.downloaded_bytes,
                total_bytes: status.size_bytes,
            },
        );
    });

    let mut status = inspect_artifact(&aqbot_home());
    status.status = "downloading".into();
    Ok(status)
}

async fn run_install(app: AppHandle, cancel: Arc<AtomicBool>) -> Result<(), String> {
    download_missing_files(Some(&app), cancel).await?;
    ensure_onnxruntime().await
}

pub(crate) async fn ensure_runtime_files() -> Result<(), String> {
    let status = inspect_artifact(&aqbot_home());
    if status.status != "installed" {
        return Err(aqbot_core::error::coded_error(
            "EMBEDDING_ARTIFACT_MISSING",
            serde_json::json!({ "backend": "builtin", "status": status.status }),
        )
        .to_string());
    }
    download_missing_files(None, Arc::new(AtomicBool::new(false))).await?;
    ensure_onnxruntime().await
}

async fn ensure_onnxruntime() -> Result<(), String> {
    crate::onnxruntime_dylib::ensure_installed(&aqbot_home())
        .await
        .map(|_| ())
        .map_err(|error| error.to_string())
}

async fn download_missing_files(
    app: Option<&AppHandle>,
    cancel: Arc<AtomicBool>,
) -> Result<(), String> {
    let home = aqbot_home();
    let client = reqwest::Client::builder()
        .user_agent("AQBot/1.0")
        .build()
        .map_err(|e| e.to_string())?;

    for file in MULTILINGUAL_E5_SMALL_INT8.files {
        let dest = artifact_file_path(&home, file.name);
        if inspect_file(&dest, file) == "installed" {
            continue;
        }
        if let Some(parent) = dest.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let partial = partial_path(&dest);
        let url = huggingface_file_url(file.name);
        let response = client.get(&url).send().await.map_err(|e| e.to_string())?;
        if !response.status().is_success() {
            return Err(format!("download failed: HTTP {}", response.status()));
        }
        let total = response.content_length().unwrap_or(file.size_bytes);
        let mut stream = response.bytes_stream();
        let mut out = std::fs::File::create(&partial).map_err(|e| e.to_string())?;
        let mut downloaded = 0u64;

        while let Some(chunk) = stream.next().await {
            if cancel.load(Ordering::SeqCst) {
                drop(out);
                let _ = std::fs::remove_file(&partial);
                return Err("cancelled".into());
            }
            let chunk = chunk.map_err(|e| e.to_string())?;
            out.write_all(&chunk).map_err(|e| e.to_string())?;
            downloaded += chunk.len() as u64;
            if let Some(app) = app {
                let _ = app.emit(
                    "embedding-artifact-progress",
                    ArtifactProgress {
                        status: "downloading".into(),
                        downloaded_bytes: downloaded,
                        total_bytes: total,
                    },
                );
            }
        }
        drop(out);
        publish_partial(&partial, &dest, file.sha256).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub async fn uninstall_embedding_artifact() -> Result<EmbeddingArtifactStatus, String> {
    crate::embedding_runtime::unload();
    uninstall_artifact(&aqbot_home()).map_err(|e| e.to_string())?;
    Ok(inspect_artifact(&aqbot_home()))
}
