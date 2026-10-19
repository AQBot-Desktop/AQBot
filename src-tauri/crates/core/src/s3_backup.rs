use aws_config::BehaviorVersion;
use aws_credential_types::{provider::SharedCredentialsProvider, Credentials};
use aws_sdk_s3::config::retry::RetryConfig;
use aws_sdk_s3::config::timeout::TimeoutConfig;
use aws_sdk_s3::config::Region;
use aws_sdk_s3::error::{ProvideErrorMetadata, SdkError};
use aws_sdk_s3::primitives::{ByteStream, DateTime, DateTimeFormat};
use aws_sdk_s3::Client;
use serde::{Deserialize, Serialize};
use std::error::Error as StdError;
use std::fmt::Debug;
use std::path::Path;
use std::time::Duration;

use crate::error::{AQBotError, Result};
use crate::webdav::parse_hostname_from_filename;

const S3_CONNECT_TIMEOUT_SECS: u64 = 10;
const S3_READ_TIMEOUT_SECS: u64 = 30;
const S3_OPERATION_ATTEMPT_TIMEOUT_SECS: u64 = 300;
const S3_OPERATION_TIMEOUT_SECS: u64 = 900;
const S3_MAX_ATTEMPTS: u32 = 5;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct S3Config {
    pub bucket: String,
    pub region: String,
    pub prefix: String,
    pub endpoint_url: Option<String>,
    pub force_path_style: bool,
    pub use_default_credentials: bool,
    pub access_key_id: String,
    pub secret_access_key: String,
    pub session_token: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct S3FileInfo {
    pub file_name: String,
    pub size: i64,
    pub last_modified: String,
    pub hostname: String,
}

pub struct S3BackupClient {
    client: Client,
    config: S3Config,
}

impl S3BackupClient {
    pub async fn new(config: S3Config) -> Result<Self> {
        validate_config(&config)?;

        let mut loader = aws_config::defaults(BehaviorVersion::latest())
            .region(Region::new(config.region.trim().to_string()));

        if !config.use_default_credentials {
            let session_token = config
                .session_token
                .as_deref()
                .map(str::trim)
                .filter(|v| !v.is_empty())
                .map(ToOwned::to_owned);
            let credentials = Credentials::new(
                config.access_key_id.trim(),
                config.secret_access_key.trim(),
                session_token,
                None,
                "aqbot-s3",
            );
            loader = loader.credentials_provider(SharedCredentialsProvider::new(credentials));
        }

        let shared_config = loader.load().await;
        let mut s3_config = aws_sdk_s3::config::Builder::from(&shared_config)
            .force_path_style(config.force_path_style)
            .timeout_config(s3_timeout_config())
            .retry_config(s3_retry_config());

        if let Some(endpoint) = normalized_endpoint(&config) {
            s3_config = s3_config.endpoint_url(endpoint);
        }

        Ok(Self {
            client: Client::from_conf(s3_config.build()),
            config,
        })
    }

    pub async fn check_connection(&self) -> Result<bool> {
        self.client
            .head_bucket()
            .bucket(bucket_name(&self.config))
            .send()
            .await
            .map_err(|e| AQBotError::Gateway(format_s3_sdk_error("connection", &e)))?;
        Ok(true)
    }

    pub async fn list_files(&self) -> Result<Vec<S3FileInfo>> {
        let mut files = Vec::new();
        let mut continuation_token = None;
        let prefix = normalize_prefix(&self.config.prefix);

        loop {
            let mut request = self
                .client
                .list_objects_v2()
                .bucket(bucket_name(&self.config))
                .prefix(&prefix);

            if let Some(token) = continuation_token {
                request = request.continuation_token(token);
            }

            let response = request
                .send()
                .await
                .map_err(|e| AQBotError::Gateway(format_s3_sdk_error("list backups", &e)))?;

            for object in response.contents() {
                let Some(key) = object.key() else {
                    continue;
                };
                let Some(file_name) = backup_file_name_from_key(&prefix, key) else {
                    continue;
                };
                files.push(S3FileInfo {
                    file_name: file_name.clone(),
                    size: object.size().unwrap_or(0),
                    last_modified: object
                        .last_modified()
                        .map(format_last_modified)
                        .unwrap_or_default(),
                    hostname: parse_hostname_from_filename(&file_name),
                });
            }

            if !response.is_truncated().unwrap_or(false) {
                break;
            }
            continuation_token = response.next_continuation_token().map(ToOwned::to_owned);
            if continuation_token.is_none() {
                break;
            }
        }

        sort_backup_files(&mut files);
        Ok(files)
    }

    pub async fn upload_file(&self, filename: &str, local_path: &Path) -> Result<()> {
        let body = ByteStream::from_path(local_path).await.map_err(|e| {
            AQBotError::Gateway(format!("Failed to read file for S3 upload: {}", e))
        })?;
        self.client
            .put_object()
            .bucket(bucket_name(&self.config))
            .key(object_key(&self.config.prefix, filename))
            .body(body)
            .send()
            .await
            .map_err(|e| AQBotError::Gateway(format_s3_sdk_error("upload", &e)))?;
        Ok(())
    }

    pub async fn download_file(&self, filename: &str, local_path: &Path) -> Result<()> {
        let response = self
            .client
            .get_object()
            .bucket(bucket_name(&self.config))
            .key(object_key(&self.config.prefix, filename))
            .send()
            .await
            .map_err(|e| AQBotError::Gateway(format_s3_sdk_error("download", &e)))?;
        let data = response
            .body
            .collect()
            .await
            .map_err(|e| AQBotError::Gateway(format!("Failed to read S3 download: {}", e)))?
            .into_bytes();
        std::fs::write(local_path, &data)
            .map_err(|e| AQBotError::Gateway(format!("Failed to write download: {}", e)))?;
        Ok(())
    }

    pub async fn delete_file(&self, filename: &str) -> Result<()> {
        self.client
            .delete_object()
            .bucket(bucket_name(&self.config))
            .key(object_key(&self.config.prefix, filename))
            .send()
            .await
            .map_err(|e| AQBotError::Gateway(format_s3_sdk_error("delete", &e)))?;
        Ok(())
    }
}

fn s3_timeout_config() -> TimeoutConfig {
    TimeoutConfig::builder()
        .connect_timeout(Duration::from_secs(S3_CONNECT_TIMEOUT_SECS))
        .read_timeout(Duration::from_secs(S3_READ_TIMEOUT_SECS))
        .operation_attempt_timeout(Duration::from_secs(S3_OPERATION_ATTEMPT_TIMEOUT_SECS))
        .operation_timeout(Duration::from_secs(S3_OPERATION_TIMEOUT_SECS))
        .build()
}

fn s3_retry_config() -> RetryConfig {
    RetryConfig::standard().with_max_attempts(S3_MAX_ATTEMPTS)
}

fn format_s3_sdk_error<E, R>(action: &str, err: &SdkError<E, R>) -> String
where
    E: ProvideErrorMetadata + StdError + 'static,
    R: Debug,
{
    let prefix = format!("S3 {} failed", action);
    match err {
        SdkError::TimeoutError(_) => {
            format!(
                "{}: request timed out. Details: {}",
                prefix,
                sdk_error_chain(err)
            )
        }
        SdkError::DispatchFailure(dispatch) => {
            let kind = if dispatch.is_timeout() {
                "timeout"
            } else if dispatch.is_io() {
                "I/O"
            } else if dispatch.is_user() {
                "request"
            } else {
                "transport"
            };
            let details = dispatch
                .as_connector_error()
                .map(|source| error_chain(source))
                .unwrap_or_else(|| sdk_error_chain(err));
            format!(
                "{}: network request failed ({}). Check S3 endpoint, proxy, DNS, and network connectivity. Details: {}",
                prefix, kind, details
            )
        }
        SdkError::ServiceError(_) => {
            let details = err
                .as_service_error()
                .and_then(service_error_details)
                .unwrap_or_else(|| sdk_error_chain(err));
            format!("{}: {}", prefix, details)
        }
        _ => format!("{}: {}", prefix, sdk_error_chain(err)),
    }
}

fn service_error_details(error: &(impl ProvideErrorMetadata + StdError)) -> Option<String> {
    match (error.code(), error.message()) {
        (Some(code), Some(message)) if !message.trim().is_empty() => {
            Some(format!("{}: {}", code, message))
        }
        (Some(code), _) => Some(code.to_string()),
        (_, Some(message)) if !message.trim().is_empty() => Some(message.to_string()),
        _ => {
            let fallback = error.to_string();
            (!fallback.trim().is_empty()).then_some(fallback)
        }
    }
}

fn sdk_error_chain<E, R>(err: &SdkError<E, R>) -> String
where
    E: StdError + 'static,
    R: Debug,
{
    StdError::source(err)
        .map(error_chain)
        .unwrap_or_else(|| err.to_string())
}

fn error_chain(mut error: &(dyn StdError + 'static)) -> String {
    let mut parts = vec![error.to_string()];
    while let Some(source) = error.source() {
        parts.push(source.to_string());
        error = source;
    }
    parts.join(": ")
}

fn validate_config(config: &S3Config) -> Result<()> {
    if config.bucket.trim().is_empty() {
        return Err(AQBotError::Gateway("S3 bucket is required".into()));
    }
    if config.region.trim().is_empty() {
        return Err(AQBotError::Gateway("S3 region is required".into()));
    }
    if !config.use_default_credentials {
        if config.access_key_id.trim().is_empty() {
            return Err(AQBotError::Gateway("S3 access key ID is required".into()));
        }
        if config.secret_access_key.trim().is_empty() {
            return Err(AQBotError::Gateway(
                "S3 secret access key is required".into(),
            ));
        }
    }
    Ok(())
}

fn bucket_name(config: &S3Config) -> &str {
    config.bucket.trim()
}

fn normalized_endpoint(config: &S3Config) -> Option<String> {
    config
        .endpoint_url
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(ToOwned::to_owned)
}

pub(crate) fn normalize_prefix(prefix: &str) -> String {
    let trimmed = prefix.trim().trim_matches('/');
    if trimmed.is_empty() {
        String::new()
    } else {
        format!("{}/", trimmed)
    }
}

pub(crate) fn object_key(prefix: &str, filename: &str) -> String {
    format!(
        "{}{}",
        normalize_prefix(prefix),
        filename.trim_start_matches('/')
    )
}

pub(crate) fn backup_file_name_from_key(prefix: &str, key: &str) -> Option<String> {
    let name = key.strip_prefix(prefix).unwrap_or(key);
    if name.contains('/') || !name.starts_with("aqbot-backup-") || !name.ends_with(".zip") {
        return None;
    }
    Some(name.to_string())
}

pub(crate) fn sort_backup_files(files: &mut [S3FileInfo]) {
    files.sort_by(|a, b| b.file_name.cmp(&a.file_name));
}

fn format_last_modified(value: &DateTime) -> String {
    value
        .fmt(DateTimeFormat::DateTime)
        .unwrap_or_else(|_| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_s3_prefix_for_object_keys() {
        assert_eq!(normalize_prefix(""), "");
        assert_eq!(normalize_prefix("/aqbot/backups/"), "aqbot/backups/");
        assert_eq!(
            object_key("/aqbot/backups/", "/backup.zip"),
            "aqbot/backups/backup.zip"
        );
    }

    #[test]
    fn filters_backup_files_from_prefixed_keys() {
        let prefix = normalize_prefix("aqbot/backups");

        assert_eq!(
            backup_file_name_from_key(
                &prefix,
                "aqbot/backups/aqbot-backup-20260515_010203.host.zip"
            ),
            Some("aqbot-backup-20260515_010203.host.zip".to_string())
        );
        assert_eq!(
            backup_file_name_from_key(
                &prefix,
                "aqbot/backups/nested/aqbot-backup-20260515_010203.host.zip"
            ),
            None
        );
        assert_eq!(
            backup_file_name_from_key(&prefix, "aqbot/backups/not-a-backup.zip"),
            None
        );
        assert_eq!(
            backup_file_name_from_key(
                &prefix,
                "aqbot/backups/aqbot-backup-20260515_010203.host.db"
            ),
            None
        );
    }

    #[test]
    fn sorts_s3_backups_newest_first_by_filename() {
        let mut files = vec![
            S3FileInfo {
                file_name: "aqbot-backup-20260514_010203.alpha.zip".to_string(),
                size: 1,
                last_modified: String::new(),
                hostname: "alpha".to_string(),
            },
            S3FileInfo {
                file_name: "aqbot-backup-20260515_010203.alpha.zip".to_string(),
                size: 1,
                last_modified: String::new(),
                hostname: "alpha".to_string(),
            },
        ];

        sort_backup_files(&mut files);

        assert_eq!(files[0].file_name, "aqbot-backup-20260515_010203.alpha.zip");
        assert_eq!(files[1].file_name, "aqbot-backup-20260514_010203.alpha.zip");
    }

    #[test]
    fn s3_client_uses_bounded_timeouts_and_extra_retries() {
        let timeout = s3_timeout_config();
        assert_eq!(
            timeout.connect_timeout(),
            Some(std::time::Duration::from_secs(S3_CONNECT_TIMEOUT_SECS))
        );
        assert_eq!(
            timeout.read_timeout(),
            Some(std::time::Duration::from_secs(S3_READ_TIMEOUT_SECS))
        );
        assert_eq!(
            timeout.operation_attempt_timeout(),
            Some(std::time::Duration::from_secs(
                S3_OPERATION_ATTEMPT_TIMEOUT_SECS
            ))
        );
        assert_eq!(
            timeout.operation_timeout(),
            Some(std::time::Duration::from_secs(S3_OPERATION_TIMEOUT_SECS))
        );
        assert_eq!(s3_retry_config().max_attempts(), S3_MAX_ATTEMPTS);
    }

    #[test]
    fn s3_dispatch_errors_are_actionable_for_users() {
        let err = aws_sdk_s3::error::SdkError::<TestServiceError, ()>::dispatch_failure(
            aws_sdk_s3::error::ConnectorError::io(Box::new(std::io::Error::new(
                std::io::ErrorKind::ConnectionReset,
                "connection reset by peer",
            ))),
        );

        let message = format_s3_sdk_error("upload", &err);

        assert!(message.contains("S3 upload failed: network request failed"));
        assert!(message.contains("endpoint"));
        assert!(message.contains("connection reset by peer"));
        assert_ne!(message, "S3 upload failed: dispatch failure");
    }

    #[test]
    fn s3_timeout_errors_are_actionable_for_users() {
        let err = aws_sdk_s3::error::SdkError::<TestServiceError, ()>::timeout_error(
            std::io::Error::new(std::io::ErrorKind::TimedOut, "deadline elapsed"),
        );

        let message = format_s3_sdk_error("upload", &err);

        assert!(message.contains("S3 upload failed: request timed out"));
        assert!(message.contains("deadline elapsed"));
    }

    #[test]
    fn s3_service_errors_keep_service_details() {
        let err = aws_sdk_s3::error::SdkError::service_error(
            TestServiceError::new("AccessDenied", "access denied by policy"),
            (),
        );

        let message = format_s3_sdk_error("upload", &err);

        assert!(message.contains("S3 upload failed: AccessDenied"));
        assert!(message.contains("access denied by policy"));
    }

    #[tokio::test]
    async fn explicit_credentials_require_access_key_and_secret() {
        let config = S3Config {
            bucket: "bucket".to_string(),
            region: "us-east-1".to_string(),
            use_default_credentials: false,
            ..Default::default()
        };

        let err = match S3BackupClient::new(config).await {
            Ok(_) => panic!("config without explicit credentials should fail"),
            Err(err) => err.to_string(),
        };

        assert!(err.contains("S3 access key ID is required"));
    }

    #[tokio::test]
    async fn default_credentials_still_require_bucket_and_region() {
        let config = S3Config {
            use_default_credentials: true,
            ..Default::default()
        };

        let err = match S3BackupClient::new(config).await {
            Ok(_) => panic!("config without bucket should fail"),
            Err(err) => err.to_string(),
        };

        assert!(err.contains("S3 bucket is required"));
    }

    #[derive(Debug)]
    struct TestServiceError {
        meta: aws_sdk_s3::error::ErrorMetadata,
    }

    impl TestServiceError {
        fn new(code: &str, message: &str) -> Self {
            Self {
                meta: aws_sdk_s3::error::ErrorMetadata::builder()
                    .code(code)
                    .message(message)
                    .build(),
            }
        }
    }

    impl std::fmt::Display for TestServiceError {
        fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
            write!(f, "test service error")
        }
    }

    impl std::error::Error for TestServiceError {}

    impl aws_sdk_s3::error::ProvideErrorMetadata for TestServiceError {
        fn meta(&self) -> &aws_sdk_s3::error::ErrorMetadata {
            &self.meta
        }
    }
}
