use unicode_normalization::UnicodeNormalization;

pub fn normalize_query(input: &str) -> String {
    input.nfkc().collect::<String>().to_lowercase()
}

pub fn text_matches(haystack: &str, needle: &str) -> bool {
    if needle.is_empty() {
        return false;
    }
    normalize_query(haystack).contains(&normalize_query(needle))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nfkc_and_casefold_match_fullwidth_and_composed_forms() {
        assert!(text_matches("Café NOTES", "CAFÉ"));
        assert!(text_matches("文件ＡＢＣ", "abc"));
        assert!(!text_matches("hello", "world"));
    }
}
