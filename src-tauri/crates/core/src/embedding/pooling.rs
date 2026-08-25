use crate::error::{coded_error, Result};

/// Mean-pool token embeddings with an attention mask, then L2-normalize each row.
pub fn mean_pool_l2(
    hidden: &[f32],
    batch: usize,
    seq: usize,
    dim: usize,
    attention_mask: &[i64],
) -> Result<Vec<Vec<f32>>> {
    let expected_hidden = batch
        .checked_mul(seq)
        .and_then(|value| value.checked_mul(dim))
        .ok_or_else(|| {
            coded_error(
                "EMBEDDING_INFERENCE_FAILED",
                serde_json::json!({ "reason": "hidden_shape_overflow" }),
            )
        })?;
    if hidden.len() != expected_hidden || attention_mask.len() != batch * seq {
        return Err(coded_error(
            "EMBEDDING_INFERENCE_FAILED",
            serde_json::json!({
                "reason": "shape",
                "hidden": hidden.len(),
                "mask": attention_mask.len(),
                "batch": batch,
                "seq": seq,
                "dim": dim
            }),
        ));
    }

    let mut out = Vec::with_capacity(batch);
    for batch_index in 0..batch {
        let mut acc = vec![0f32; dim];
        let mut count = 0f32;
        for seq_index in 0..seq {
            if attention_mask[batch_index * seq + seq_index] == 0 {
                continue;
            }
            count += 1.0;
            let offset = (batch_index * seq + seq_index) * dim;
            for dim_index in 0..dim {
                acc[dim_index] += hidden[offset + dim_index];
            }
        }
        if count == 0.0 {
            count = 1.0;
        }
        for value in &mut acc {
            *value /= count;
        }
        let mut norm = acc.iter().map(|value| value * value).sum::<f32>().sqrt();
        if norm < 1e-12 {
            norm = 1.0;
        }
        for value in &mut acc {
            *value /= norm;
        }
        if acc.iter().any(|value| !value.is_finite()) {
            return Err(coded_error(
                "EMBEDDING_NON_FINITE",
                serde_json::json!({ "index": batch_index }),
            ));
        }
        out.push(acc);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pools_unmasked_tokens_and_normalizes() {
        let hidden = vec![
            1.0, 0.0, 3.0, 0.0, // token 0, then masked token 1
        ];
        let mask = vec![1, 0];
        let vectors = mean_pool_l2(&hidden, 1, 2, 2, &mask).unwrap();
        assert_eq!(vectors.len(), 1);
        assert!((vectors[0][0] - 1.0).abs() < 1e-5);
        assert!(vectors[0][1].abs() < 1e-5);
    }

    #[test]
    fn averages_unmasked_tokens() {
        let hidden = vec![2.0, 0.0, 0.0, 2.0];
        let mask = vec![1, 1];
        let vectors = mean_pool_l2(&hidden, 1, 2, 2, &mask).unwrap();
        let expected = 1.0 / 2f32.sqrt();
        assert!((vectors[0][0] - expected).abs() < 1e-5);
        assert!((vectors[0][1] - expected).abs() < 1e-5);
    }
}
