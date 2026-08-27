use font_kit::properties::Style;
use font_kit::source::SystemSource;
use serde::Serialize;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct SystemFontFace {
    pub name: String,
    pub weight: u16,
    pub style: String,
    pub local_names: Vec<String>,
}

#[tauri::command]
pub async fn list_system_fonts() -> Result<Vec<String>, String> {
    tokio::task::spawn_blocking(|| {
        let source = SystemSource::new();
        let mut families = source.all_families().map_err(|e| e.to_string())?;
        families.sort_by(|a, b| a.to_lowercase().cmp(&b.to_lowercase()));
        Ok(families)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn list_system_font_faces(family: String) -> Result<Vec<SystemFontFace>, String> {
    tokio::task::spawn_blocking(move || Ok(collect_system_font_faces(&family)))
        .await
        .map_err(|e| e.to_string())?
}

fn collect_system_font_faces(family: &str) -> Vec<SystemFontFace> {
    let family = family.trim();
    if family.is_empty() {
        return Vec::new();
    }
    let source = SystemSource::new();
    let handle = match source.select_family_by_name(family) {
        Ok(handle) => handle,
        Err(_) => return Vec::new(),
    };

    let mut faces = Vec::new();
    for font_handle in handle.fonts() {
        let font = match font_handle.load() {
            Ok(font) => font,
            Err(_) => continue,
        };
        let properties = font.properties();
        let style = css_style(properties.style);
        let weight = css_weight(properties.weight.0);
        let os_style_name = os_style_name(&font);
        let name = face_style_label(
            &font.full_name(),
            family,
            os_style_name.as_deref(),
            weight,
            style,
        );
        let mut local_names = Vec::new();
        push_unique(&mut local_names, font.full_name());
        if let Some(postscript) = font.postscript_name() {
            push_unique(&mut local_names, postscript);
        }
        if let Some(style_name) = os_style_name {
            push_unique(&mut local_names, format!("{family} {style_name}"));
        }
        faces.push(SystemFontFace {
            name,
            weight,
            style: style.to_string(),
            local_names,
        });
    }

    dedupe_faces(faces)
}

fn os_style_name(font: &font_kit::font::Font) -> Option<String> {
    #[cfg(any(target_os = "macos", target_os = "ios"))]
    {
        let name = font.style_name();
        if !name.trim().is_empty() {
            return Some(name);
        }
    }
    let _ = font;
    None
}

pub fn face_style_label(
    full_name: &str,
    family: &str,
    style_name: Option<&str>,
    weight: u16,
    style: &str,
) -> String {
    if let Some(name) = style_name.map(str::trim).filter(|value| !value.is_empty()) {
        if !name.eq_ignore_ascii_case(family) {
            return name.to_string();
        }
    }
    if let Some(rest) = strip_family_prefix(full_name, family) {
        if !rest.is_empty() && !rest.eq_ignore_ascii_case(family) {
            return rest;
        }
    }
    fallback_style_name(weight, style)
}

fn strip_family_prefix(full_name: &str, family: &str) -> Option<String> {
    let full = full_name.trim();
    let family = family.trim();
    if family.is_empty() || full.len() < family.len() {
        return None;
    }
    if !full[..family.len()].eq_ignore_ascii_case(family) {
        return None;
    }
    let rest = full[family.len()..]
        .trim()
        .trim_start_matches('-')
        .trim();
    Some(rest.to_string())
}

fn fallback_style_name(weight: u16, style: &str) -> String {
    let weight_name = match weight {
        0..=149 => "Thin",
        150..=249 => "Extra Light",
        250..=349 => "Light",
        350..=449 => "Regular",
        450..=549 => "Medium",
        550..=649 => "SemiBold",
        650..=749 => "Bold",
        750..=849 => "Extra Bold",
        _ => "Black",
    };
    match style {
        "italic" if weight_name == "Regular" => "Italic".to_string(),
        "oblique" if weight_name == "Regular" => "Oblique".to_string(),
        "italic" => format!("{weight_name} Italic"),
        "oblique" => format!("{weight_name} Oblique"),
        _ => weight_name.to_string(),
    }
}

fn css_style(style: Style) -> &'static str {
    match style {
        Style::Italic => "italic",
        Style::Oblique => "oblique",
        Style::Normal => "normal",
    }
}

fn css_weight(value: f32) -> u16 {
    value.round().clamp(1.0, 1000.0) as u16
}

fn push_unique(values: &mut Vec<String>, value: String) {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return;
    }
    if values.iter().any(|existing| existing == trimmed) {
        return;
    }
    values.push(trimmed.to_string());
}

fn prefer_name(candidate: &str, current: &str) -> bool {
    let candidate_has_digit = candidate.chars().any(|ch| ch.is_ascii_digit());
    let current_has_digit = current.chars().any(|ch| ch.is_ascii_digit());
    if candidate_has_digit != current_has_digit {
        return candidate_has_digit;
    }
    candidate.len() > current.len()
}

fn dedupe_faces(mut faces: Vec<SystemFontFace>) -> Vec<SystemFontFace> {
    faces.sort_by(|left, right| {
        left.weight
            .cmp(&right.weight)
            .then_with(|| left.style.cmp(&right.style))
            .then_with(|| left.name.cmp(&right.name))
    });
    let mut result: Vec<SystemFontFace> = Vec::new();
    for face in faces {
        if let Some(existing) = result
            .iter_mut()
            .find(|item| item.weight == face.weight && item.style == face.style)
        {
            if prefer_name(&face.name, &existing.name) {
                existing.name = face.name;
            }
            for name in face.local_names {
                push_unique(&mut existing.local_names, name);
            }
        } else {
            result.push(face);
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn uses_os_style_name_for_alibaba_faces() {
        assert_eq!(
            face_style_label(
                "Alibaba PuHuiTi 3.0 65 Medium",
                "Alibaba PuHuiTi 3.0",
                Some("65 Medium"),
                500,
                "normal",
            ),
            "65 Medium"
        );
    }

    #[test]
    fn strips_family_prefix_from_the_full_name() {
        assert_eq!(
            face_style_label(
                "Alibaba PuHuiTi 3.0 55 Regular",
                "Alibaba PuHuiTi 3.0",
                None,
                400,
                "normal",
            ),
            "55 Regular"
        );
    }

    #[test]
    fn falls_back_to_css_weight_names() {
        assert_eq!(
            face_style_label("Inter", "Inter", None, 400, "normal"),
            "Regular"
        );
        assert_eq!(
            face_style_label("Inter", "Inter", None, 400, "italic"),
            "Italic"
        );
        assert_eq!(
            face_style_label("Inter", "Inter", None, 700, "italic"),
            "Bold Italic"
        );
    }

    #[test]
    fn prefers_numbered_style_names_when_deduping() {
        let faces = dedupe_faces(vec![
            SystemFontFace {
                name: "Medium".to_string(),
                weight: 500,
                style: "normal".to_string(),
                local_names: vec!["Medium".to_string()],
            },
            SystemFontFace {
                name: "65 Medium".to_string(),
                weight: 500,
                style: "normal".to_string(),
                local_names: vec!["Alibaba PuHuiTi 3.0 65 Medium".to_string()],
            },
        ]);
        assert_eq!(faces.len(), 1);
        assert_eq!(faces[0].name, "65 Medium");
        assert_eq!(faces[0].local_names.len(), 2);
    }
}
