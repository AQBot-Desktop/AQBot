use aes_gcm::{
    aead::{rand_core::RngCore, Aead, KeyInit, OsRng},
    Aes256Gcm, Nonce,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use sha2::{Digest, Sha256};

use crate::error::{AQBotError, Result};

const NONCE_SIZE: usize = 12;

pub fn generate_master_key() -> [u8; 32] {
    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    key
}

pub fn encrypt_key(plaintext: &str, master_key: &[u8; 32]) -> Result<String> {
    let cipher = Aes256Gcm::new_from_slice(master_key)
        .map_err(|e| AQBotError::Crypto(format!("Failed to create cipher: {}", e)))?;

    let mut nonce_bytes = [0u8; NONCE_SIZE];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);

    let ciphertext = cipher
        .encrypt(nonce, plaintext.as_bytes())
        .map_err(|e| AQBotError::Crypto(format!("Encryption failed: {}", e)))?;

    let mut combined = Vec::with_capacity(NONCE_SIZE + ciphertext.len());
    combined.extend_from_slice(&nonce_bytes);
    combined.extend_from_slice(&ciphertext);

    Ok(BASE64.encode(&combined))
}

pub fn decrypt_key(encrypted: &str, master_key: &[u8; 32]) -> Result<String> {
    let combined = BASE64
        .decode(encrypted)
        .map_err(|e| AQBotError::Crypto(format!("Base64 decode failed: {}", e)))?;

    if combined.len() < NONCE_SIZE {
        return Err(AQBotError::Crypto("Invalid encrypted data".to_string()));
    }

    let (nonce_bytes, ciphertext) = combined.split_at(NONCE_SIZE);
    let nonce = Nonce::from_slice(nonce_bytes);

    let cipher = Aes256Gcm::new_from_slice(master_key)
        .map_err(|e| AQBotError::Crypto(format!("Failed to create cipher: {}", e)))?;

    let plaintext = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| AQBotError::Crypto(format!("Decryption failed: {}", e)))?;

    String::from_utf8(plaintext)
        .map_err(|e| AQBotError::Crypto(format!("UTF-8 decode failed: {}", e)))
}

pub fn sha256_hash(input: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(input.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn key_prefix(key: &str) -> String {
    if key.len() > 8 {
        format!("{}...{}", &key[..4], &key[key.len() - 4..])
    } else {
        "****".to_string()
    }
}

pub fn generate_gateway_key() -> String {
    let mut bytes = [0u8; 32];
    OsRng.fill_bytes(&mut bytes);
    format!("aq-{}", hex::encode(bytes))
}
