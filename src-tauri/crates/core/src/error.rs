use thiserror::Error;

#[derive(Debug, Error)]
pub enum AQBotError {
    #[error("Database error: {0}")]
    Database(#[from] sea_orm::DbErr),
    #[error("Provider error: {0}")]
    Provider(String),
    #[error("Gateway error: {0}")]
    Gateway(String),
    #[error("Crypto error: {0}")]
    Crypto(String),
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Validation error: {0}")]
    Validation(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

impl serde::Serialize for AQBotError {
    fn serialize<S>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl From<sea_orm::TransactionError<sea_orm::DbErr>> for AQBotError {
    fn from(err: sea_orm::TransactionError<sea_orm::DbErr>) -> Self {
        match err {
            sea_orm::TransactionError::Connection(e) => AQBotError::Database(e),
            sea_orm::TransactionError::Transaction(e) => AQBotError::Database(e),
        }
    }
}

pub type Result<T> = std::result::Result<T, AQBotError>;
