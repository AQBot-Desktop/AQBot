use std::sync::{Mutex, OnceLock};

use aqbot_core::embedding::{
    artifact_file_path, inspect_artifact, mean_pool_l2, MULTILINGUAL_E5_SMALL_INT8,
};
use aqbot_core::error::{coded_error, Result};
use ndarray::Array2;
use ort::session::Session;
use ort::value::TensorRef;
use tokenizers::tokenizer::TruncationDirection;
use tokenizers::{
    PaddingDirection, PaddingParams, PaddingStrategy, Tokenizer, TruncationParams,
    TruncationStrategy,
};

use crate::commands::embedding_artifact::ensure_runtime_files;
use crate::paths::aqbot_home;

const INFER_BATCH: usize = 8;

struct BuiltinEngine {
    tokenizer: Tokenizer,
    session: Session,
    wants_token_type_ids: bool,
    output_name: String,
}

static ENGINE: OnceLock<Mutex<Option<BuiltinEngine>>> = OnceLock::new();

fn engine_lock() -> &'static Mutex<Option<BuiltinEngine>> {
    ENGINE.get_or_init(|| Mutex::new(None))
}

pub fn unload() {
    if let Ok(mut guard) = engine_lock().lock() {
        *guard = None;
    }
}

fn infer_error(reason: impl ToString) -> aqbot_core::error::AQBotError {
    coded_error(
        "EMBEDDING_INFERENCE_FAILED",
        serde_json::json!({ "reason": reason.to_string() }),
    )
}

fn load_engine() -> Result<BuiltinEngine> {
    let home = aqbot_home();
    let status = inspect_artifact(&home);
    if status.status != "installed" {
        return Err(coded_error(
            "EMBEDDING_ARTIFACT_MISSING",
            serde_json::json!({ "backend": "builtin", "status": status.status }),
        ));
    }
    let tokenizer_path = artifact_file_path(&home, "tokenizer.json");
    let mut tokenizer = Tokenizer::from_file(&tokenizer_path).map_err(infer_error)?;
    let pad_id = tokenizer.token_to_id("<pad>").unwrap_or(1);
    tokenizer
        .with_truncation(Some(TruncationParams {
            max_length: MULTILINGUAL_E5_SMALL_INT8.max_length,
            stride: 0,
            strategy: TruncationStrategy::LongestFirst,
            direction: TruncationDirection::Right,
        }))
        .map_err(infer_error)?;
    tokenizer.with_padding(Some(PaddingParams {
        strategy: PaddingStrategy::BatchLongest,
        direction: PaddingDirection::Right,
        pad_to_multiple_of: None,
        pad_id,
        pad_type_id: 0,
        pad_token: "<pad>".into(),
    }));

    let model_path = artifact_file_path(&home, MULTILINGUAL_E5_SMALL_INT8.files[0].name);
    let dylib = crate::onnxruntime_dylib::resolve_installed(&home)?;
    crate::onnxruntime_dylib::init_ort(&dylib)?;
    let session = Session::builder()
        .map_err(infer_error)?
        .commit_from_file(&model_path)
        .map_err(infer_error)?;
    let wants_token_type_ids = session
        .inputs()
        .iter()
        .any(|input| input.name() == "token_type_ids");
    let output_name = session
        .outputs()
        .iter()
        .map(|output| output.name().to_string())
        .find(|name| name == "last_hidden_state")
        .or_else(|| {
            session
                .outputs()
                .first()
                .map(|output| output.name().to_string())
        })
        .ok_or_else(|| infer_error("missing_output"))?;

    Ok(BuiltinEngine {
        tokenizer,
        session,
        wants_token_type_ids,
        output_name,
    })
}

fn infer_batch(engine: &mut BuiltinEngine, texts: &[String]) -> Result<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    let encodings = engine
        .tokenizer
        .encode_batch(texts.to_vec(), true)
        .map_err(infer_error)?;
    let batch = encodings.len();
    let seq = encodings
        .iter()
        .map(|encoding| encoding.len())
        .max()
        .unwrap_or(0);
    if seq == 0 {
        return Ok(vec![
            vec![0.0; MULTILINGUAL_E5_SMALL_INT8.dimensions];
            batch
        ]);
    }

    let mut ids = vec![0i64; batch * seq];
    let mut mask = vec![0i64; batch * seq];
    let mut types = vec![0i64; batch * seq];
    for (row, encoding) in encodings.iter().enumerate() {
        for (col, token_id) in encoding.get_ids().iter().enumerate() {
            ids[row * seq + col] = i64::from(*token_id);
        }
        for (col, value) in encoding.get_attention_mask().iter().enumerate() {
            mask[row * seq + col] = i64::from(*value);
        }
        for (col, value) in encoding.get_type_ids().iter().enumerate() {
            types[row * seq + col] = i64::from(*value);
        }
    }

    let ids_array = Array2::from_shape_vec((batch, seq), ids).map_err(infer_error)?;
    let mask_array = Array2::from_shape_vec((batch, seq), mask.clone()).map_err(infer_error)?;
    let types_array = Array2::from_shape_vec((batch, seq), types).map_err(infer_error)?;

    let outputs = if engine.wants_token_type_ids {
        engine
            .session
            .run(ort::inputs![
                "input_ids" => TensorRef::from_array_view(&ids_array).map_err(infer_error)?,
                "attention_mask" => TensorRef::from_array_view(&mask_array).map_err(infer_error)?,
                "token_type_ids" => TensorRef::from_array_view(&types_array).map_err(infer_error)?,
            ])
            .map_err(infer_error)?
    } else {
        engine
            .session
            .run(ort::inputs![
                "input_ids" => TensorRef::from_array_view(&ids_array).map_err(infer_error)?,
                "attention_mask" => TensorRef::from_array_view(&mask_array).map_err(infer_error)?,
            ])
            .map_err(infer_error)?
    };

    let (shape, hidden) = outputs[engine.output_name.as_str()]
        .try_extract_tensor::<f32>()
        .map_err(infer_error)?;
    if shape.len() != 3 {
        return Err(infer_error(format!("unexpected_rank_{}", shape.len())));
    }
    let out_batch = usize::try_from(shape[0]).map_err(infer_error)?;
    let out_seq = usize::try_from(shape[1]).map_err(infer_error)?;
    let out_dim = usize::try_from(shape[2]).map_err(infer_error)?;
    mean_pool_l2(hidden, out_batch, out_seq, out_dim, &mask)
}

pub async fn embed_prefixed(texts: Vec<String>) -> Result<Vec<Vec<f32>>> {
    if texts.is_empty() {
        return Ok(Vec::new());
    }
    ensure_runtime_files()
        .await
        .map_err(aqbot_core::error::AQBotError::Coded)?;
    tokio::task::spawn_blocking(move || {
        let mut guard = engine_lock()
            .lock()
            .map_err(|_| infer_error("engine_lock"))?;
        if guard.is_none() {
            *guard = Some(load_engine()?);
        }
        let engine = guard
            .as_mut()
            .ok_or_else(|| infer_error("engine_missing"))?;
        let mut all = Vec::with_capacity(texts.len());
        for chunk in texts.chunks(INFER_BATCH) {
            all.extend(infer_batch(engine, chunk)?);
        }
        Ok(all)
    })
    .await
    .map_err(infer_error)?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn embeds_with_installed_artifact() {
        let home = crate::paths::aqbot_home();
        if inspect_artifact(&home).status != "installed" {
            return;
        }
        let vectors = embed_prefixed(vec!["hello world".into()])
            .await
            .expect("builtin embed");
        assert_eq!(vectors.len(), 1);
        assert_eq!(vectors[0].len(), MULTILINGUAL_E5_SMALL_INT8.dimensions);
        let norm = vectors[0]
            .iter()
            .map(|value| value * value)
            .sum::<f32>()
            .sqrt();
        assert!((norm - 1.0).abs() < 1e-3, "l2 norm {norm}");
    }
}
