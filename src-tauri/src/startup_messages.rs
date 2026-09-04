fn locale_source(locale: &str) -> &'static str {
    let normalized = locale.replace('_', "-").to_ascii_lowercase();
    match normalized.split('-').next().unwrap_or("en") {
        "zh" if normalized.contains("hant")
            || normalized.ends_with("-tw")
            || normalized.ends_with("-hk")
            || normalized.ends_with("-mo") =>
        {
            include_str!("../../src/i18n/locales/zh-TW.json")
        }
        "zh" => include_str!("../../src/i18n/locales/zh-CN.json"),
        "ar" => include_str!("../../src/i18n/locales/ar.json"),
        "de" => include_str!("../../src/i18n/locales/de.json"),
        "es" => include_str!("../../src/i18n/locales/es.json"),
        "fr" => include_str!("../../src/i18n/locales/fr.json"),
        "hi" => include_str!("../../src/i18n/locales/hi.json"),
        "ja" => include_str!("../../src/i18n/locales/ja.json"),
        "ko" => include_str!("../../src/i18n/locales/ko.json"),
        "ru" => include_str!("../../src/i18n/locales/ru.json"),
        _ => include_str!("../../src/i18n/locales/en-US.json"),
    }
}

fn message(locale: &str, key: &str, values: &[(&str, &str)]) -> Result<(String, String), String> {
    let translations: serde_json::Value = serde_json::from_str(locale_source(locale))
        .map_err(|error| format!("Invalid startup translations: {error}"))?;
    let startup = &translations["startup"];
    let title = required_text(startup, "nativeTitle")?;
    let mut body = required_text(startup, key)?.to_string();
    for (name, value) in values {
        body = body.replace(&format!("{{{{{name}}}}}"), value);
    }
    Ok((title.to_string(), body))
}

fn required_text<'a>(startup: &'a serde_json::Value, key: &str) -> Result<&'a str, String> {
    startup[key]
        .as_str()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| format!("Missing startup translation: startup.{key}"))
}

#[cfg(target_os = "windows")]
fn show_message(key: &str, values: &[(&str, &str)]) {
    let locale = match crate::windows_utils::system_locale() {
        Ok(locale) => locale,
        Err(error) => {
            tracing::warn!(%error, "Could not read Windows display language; using English");
            "en-US".to_string()
        }
    };
    match message(&locale, key, values) {
        Ok((title, body)) if key == "slowStartup" => {
            crate::windows_utils::show_warning_dialog(&title, &body)
        }
        Ok((title, body)) => crate::windows_utils::show_error_dialog(&title, &body),
        Err(error) => tracing::error!(%error, "Could not render AQBot native startup message"),
    }
}

#[cfg(target_os = "windows")]
pub fn show_failure(error: &str) {
    let log_path = crate::diagnostic_log::path().to_string_lossy().into_owned();
    show_message("nativeFailure", &[("error", error), ("logPath", &log_path)]);
}

#[cfg(target_os = "windows")]
pub fn show_slow_startup(phase: &str) {
    let log_path = crate::diagnostic_log::path().to_string_lossy().into_owned();
    show_message("slowStartup", &[("phase", phase), ("logPath", &log_path)]);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_supported_locales_have_native_startup_messages() {
        for locale in [
            "zh-CN", "zh-TW", "en-US", "ar", "de", "es", "fr", "hi", "ja", "ko", "ru",
        ] {
            let (_, slow) = message(
                locale,
                "slowStartup",
                &[("phase", "webview"), ("logPath", "aqbot.log")],
            )
            .unwrap();
            assert!(slow.contains("webview"), "{locale}");
            assert!(slow.contains("aqbot.log"), "{locale}");
            assert!(!slow.contains("{{"), "{locale}");
            let (_, failed) = message(
                locale,
                "nativeFailure",
                &[("error", "E_FAIL"), ("logPath", "aqbot.log")],
            )
            .unwrap();
            assert!(failed.contains("E_FAIL"), "{locale}");
            assert!(failed.contains("aqbot.log"), "{locale}");
            assert!(!failed.contains("{{"), "{locale}");
        }
    }

    #[test]
    fn maps_windows_regional_locales_to_existing_translations() {
        assert_eq!(locale_source("zh-HK"), locale_source("zh-TW"));
        assert_eq!(locale_source("zh-Hant"), locale_source("zh-TW"));
        assert_eq!(locale_source("zh-SG"), locale_source("zh-CN"));
        assert_eq!(locale_source("fr-CA"), locale_source("fr"));
        assert_eq!(locale_source("ko_KR"), locale_source("ko"));
        assert_eq!(locale_source("nl-NL"), locale_source("en-US"));
    }

    #[test]
    fn missing_message_is_an_explicit_error() {
        assert!(message("en-US", "missing", &[])
            .unwrap_err()
            .contains("startup.missing"));
    }
}
