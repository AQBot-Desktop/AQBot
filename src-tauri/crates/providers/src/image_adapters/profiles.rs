use super::{
    ImageAdapterConfig, ImageAdapterRequest, ImageApiMode, ImageModelDescriptor, ImageModelWarning,
    ImageOperation, ImageParameterDescriptor, ImageParameterKind,
};
use aqbot_core::error::{AQBotError, Result};
use serde_json::Value;
use std::collections::HashSet;

const GEMINI_IMAGE_DOCS: &str = "https://ai.google.dev/gemini-api/docs/image-generation";
const IMAGEN_DOCS: &str = "https://ai.google.dev/gemini-api/docs/imagen";
const OPENAI_IMAGE_DOCS: &str = "https://developers.openai.com/api/docs/guides/image-generation";
const XAI_IMAGE_DOCS: &str = "https://docs.x.ai/developers/rest-api-reference/inference/images";
const GLM_IMAGE_DOCS: &str = "https://docs.bigmodel.cn/api-reference/模型-api/图像生成";
const SILICONFLOW_IMAGE_DOCS: &str =
    "https://docs.siliconflow.cn/cn/api-reference/images/images-generations";
const PROFILE_AUDITED_AT: &str = "2026-07-29";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ImageModelFamily {
    OpenAiGpt2,
    OpenAiGptLegacy,
    DallE2,
    DallE3,
    XaiImagine,
    Gemini31Flash,
    Gemini31FlashLite,
    Gemini3Pro,
    Gemini25,
    Imagen4Standard,
    Imagen4Ultra,
    Imagen4Fast,
    GlmImage,
    CogView,
    SiliconKolors,
    SiliconQwen,
    SiliconQwenEdit,
    Generic,
    Unknown,
}

#[derive(Debug, Clone)]
pub(crate) struct ImageModelProfile {
    pub family: ImageModelFamily,
    pub descriptor: ImageModelDescriptor,
    pub api_mode: ImageApiMode,
    pub official_docs: Option<&'static str>,
    pub audited_at: &'static str,
}

/// Built-in parameter presets users can select as a fallback schema.
pub const BUILTIN_PARAM_PROFILES: &[&str] = &[
    "openai_gpt_image_2",
    "openai_gpt_image_legacy",
    "openai_dalle_2",
    "openai_dalle_3",
    "xai_imagine",
    "gemini_3_1_flash",
    "gemini_3_1_flash_lite",
    "gemini_3_pro",
    "gemini_2_5",
    "imagen_4",
    "imagen_4_ultra",
    "imagen_4_fast",
    "glm_image",
    "cogview",
    "siliconflow_kolors",
    "siliconflow_qwen",
    "siliconflow_qwen_edit",
];

/// Resolve the parameter/capability profile for an image model.
///
/// Priority:
/// 1. `descriptor_override` (full custom schema)
/// 2. explicit `param_profile` preset
/// 3. family match from `(adapter_id, model_id)`
/// 4. adapter default profile (never an empty conservative shell)
pub(crate) fn image_model_profile(
    adapter_id: &str,
    model_id: &str,
    config: &ImageAdapterConfig,
) -> ImageModelProfile {
    // 1. Full descriptor override (any adapter)
    if let Some(override_descriptor) = &config.descriptor_override {
        let mut descriptor = override_descriptor.clone();
        descriptor.adapter_id = adapter_id.to_string();
        apply_operation_overrides(&mut descriptor, config);
        return ImageModelProfile {
            family: ImageModelFamily::Generic,
            descriptor,
            api_mode: ImageApiMode::Auto,
            official_docs: None,
            audited_at: PROFILE_AUDITED_AT,
        };
    }

    // 2. Explicit param profile preset
    if let Some(profile_id) = config
        .param_profile
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        if let Some(family) = family_from_param_profile(profile_id) {
            return profile_for_family(adapter_id, model_id, family, config);
        }
    }

    // 3. Verified family match under the active adapter
    let matched = match_family(adapter_id, model_id);
    if !matches!(
        matched,
        ImageModelFamily::Unknown | ImageModelFamily::Generic
    ) {
        return profile_for_family(adapter_id, model_id, matched, config);
    }

    // 4. Adapter default — usable OpenAI-style (or vendor) params, soft notice only
    let default_family = adapter_default_family(adapter_id);
    let mut profile = profile_for_family(adapter_id, model_id, default_family, config);
    let preset_id = param_profile_id_for_family(default_family);
    if profile.descriptor.warnings.is_empty() {
        profile.descriptor.warnings = fallback_profile_warning(model_id, preset_id);
    }
    profile
}

fn match_family(adapter_id: &str, model_id: &str) -> ImageModelFamily {
    let normalized = model_id.trim().to_ascii_lowercase();
    match adapter_id {
        "openai_images" if normalized.starts_with("gpt-image-2") => ImageModelFamily::OpenAiGpt2,
        "openai_images" if normalized.starts_with("gpt-image-") => {
            ImageModelFamily::OpenAiGptLegacy
        }
        "openai_images" if normalized.starts_with("dall-e-2") => ImageModelFamily::DallE2,
        "openai_images" if normalized.starts_with("dall-e-3") => ImageModelFamily::DallE3,
        // Official: grok-imagine-image / grok-imagine-image-quality; aliases like grok-image*
        "xai_images" => ImageModelFamily::XaiImagine,
        "gemini_images" if normalized.starts_with("imagen-4.0-ultra") => {
            ImageModelFamily::Imagen4Ultra
        }
        "gemini_images" if normalized.starts_with("imagen-4.0-fast") => {
            ImageModelFamily::Imagen4Fast
        }
        "gemini_images" if normalized.starts_with("imagen-4.0-") => {
            ImageModelFamily::Imagen4Standard
        }
        "gemini_images" if normalized.contains("3.1-flash-lite-image") => {
            ImageModelFamily::Gemini31FlashLite
        }
        "gemini_images" if normalized.contains("3.1-flash-image") => {
            ImageModelFamily::Gemini31Flash
        }
        "gemini_images"
            if normalized.contains("3-pro-image") || normalized.contains("nano-banana-pro") =>
        {
            ImageModelFamily::Gemini3Pro
        }
        "gemini_images" if normalized.contains("2.5-flash-image") => ImageModelFamily::Gemini25,
        "glm_images" if normalized.starts_with("glm-image") => ImageModelFamily::GlmImage,
        "glm_images" if normalized.starts_with("cogview") => ImageModelFamily::CogView,
        "siliconflow_images" if normalized.contains("qwen-image-edit") => {
            ImageModelFamily::SiliconQwenEdit
        }
        "siliconflow_images" if normalized.contains("qwen-image") => ImageModelFamily::SiliconQwen,
        "siliconflow_images" if normalized.contains("kolors") => ImageModelFamily::SiliconKolors,
        _ => ImageModelFamily::Unknown,
    }
}

fn adapter_default_family(adapter_id: &str) -> ImageModelFamily {
    match adapter_id {
        "openai_images" | "generic_json" => ImageModelFamily::OpenAiGpt2,
        "xai_images" => ImageModelFamily::XaiImagine,
        "gemini_images" => ImageModelFamily::Gemini31Flash,
        "glm_images" => ImageModelFamily::GlmImage,
        "siliconflow_images" => ImageModelFamily::SiliconKolors,
        _ => ImageModelFamily::OpenAiGpt2,
    }
}

fn family_from_param_profile(profile_id: &str) -> Option<ImageModelFamily> {
    match profile_id {
        "openai_gpt_image_2" => Some(ImageModelFamily::OpenAiGpt2),
        "openai_gpt_image_legacy" => Some(ImageModelFamily::OpenAiGptLegacy),
        "openai_dalle_2" => Some(ImageModelFamily::DallE2),
        "openai_dalle_3" => Some(ImageModelFamily::DallE3),
        "xai_imagine" => Some(ImageModelFamily::XaiImagine),
        "gemini_3_1_flash" => Some(ImageModelFamily::Gemini31Flash),
        "gemini_3_1_flash_lite" => Some(ImageModelFamily::Gemini31FlashLite),
        "gemini_3_pro" => Some(ImageModelFamily::Gemini3Pro),
        "gemini_2_5" => Some(ImageModelFamily::Gemini25),
        "imagen_4" => Some(ImageModelFamily::Imagen4Standard),
        "imagen_4_ultra" => Some(ImageModelFamily::Imagen4Ultra),
        "imagen_4_fast" => Some(ImageModelFamily::Imagen4Fast),
        "glm_image" => Some(ImageModelFamily::GlmImage),
        "cogview" => Some(ImageModelFamily::CogView),
        "siliconflow_kolors" => Some(ImageModelFamily::SiliconKolors),
        "siliconflow_qwen" => Some(ImageModelFamily::SiliconQwen),
        "siliconflow_qwen_edit" => Some(ImageModelFamily::SiliconQwenEdit),
        _ => None,
    }
}

fn param_profile_id_for_family(family: ImageModelFamily) -> &'static str {
    match family {
        ImageModelFamily::OpenAiGpt2 => "openai_gpt_image_2",
        ImageModelFamily::OpenAiGptLegacy => "openai_gpt_image_legacy",
        ImageModelFamily::DallE2 => "openai_dalle_2",
        ImageModelFamily::DallE3 => "openai_dalle_3",
        ImageModelFamily::XaiImagine => "xai_imagine",
        ImageModelFamily::Gemini31Flash => "gemini_3_1_flash",
        ImageModelFamily::Gemini31FlashLite => "gemini_3_1_flash_lite",
        ImageModelFamily::Gemini3Pro => "gemini_3_pro",
        ImageModelFamily::Gemini25 => "gemini_2_5",
        ImageModelFamily::Imagen4Standard => "imagen_4",
        ImageModelFamily::Imagen4Ultra => "imagen_4_ultra",
        ImageModelFamily::Imagen4Fast => "imagen_4_fast",
        ImageModelFamily::GlmImage => "glm_image",
        ImageModelFamily::CogView => "cogview",
        ImageModelFamily::SiliconKolors => "siliconflow_kolors",
        ImageModelFamily::SiliconQwen => "siliconflow_qwen",
        ImageModelFamily::SiliconQwenEdit => "siliconflow_qwen_edit",
        ImageModelFamily::Generic | ImageModelFamily::Unknown => "openai_gpt_image_2",
    }
}

fn profile_for_family(
    adapter_id: &str,
    model_id: &str,
    family: ImageModelFamily,
    config: &ImageAdapterConfig,
) -> ImageModelProfile {
    let generate = vec![ImageOperation::Generate];
    let edit = vec![ImageOperation::Generate, ImageOperation::Edit];
    let mask = vec![
        ImageOperation::Generate,
        ImageOperation::Edit,
        ImageOperation::MaskEdit,
    ];
    match family {
        ImageModelFamily::OpenAiGpt2 => profile(
            adapter_id,
            family,
            mask,
            vec![
                string_parameter(
                    "size",
                    "auto",
                    &["auto", "1024x1024", "1536x1024", "1024x1536"],
                ),
                select_parameter("quality", "auto", &["auto", "low", "medium", "high"]),
                select_parameter("output_format", "png", &["png", "jpeg", "webp"]),
                select_parameter("background", "auto", &["auto", "opaque"]),
                optional_number_parameter("output_compression", 0.0, 100.0),
                number_parameter("n", 1.0, 10.0, 1.0),
            ],
            10,
            16,
            vec![],
            config,
        ),
        ImageModelFamily::OpenAiGptLegacy => profile(
            adapter_id,
            family,
            mask,
            vec![
                select_parameter(
                    "size",
                    "auto",
                    &["auto", "1024x1024", "1536x1024", "1024x1536"],
                ),
                select_parameter("quality", "auto", &["auto", "low", "medium", "high"]),
                select_parameter("output_format", "png", &["png", "jpeg", "webp"]),
                select_parameter("background", "auto", &["auto", "opaque", "transparent"]),
                optional_number_parameter("output_compression", 0.0, 100.0),
                number_parameter("n", 1.0, 10.0, 1.0),
            ],
            10,
            16,
            legacy_warning(model_id, "gpt-image-2"),
            config,
        ),
        ImageModelFamily::DallE2 => profile(
            adapter_id,
            family,
            mask,
            vec![
                select_parameter("size", "1024x1024", &["256x256", "512x512", "1024x1024"]),
                select_parameter("quality", "standard", &["standard"]),
                number_parameter("n", 1.0, 10.0, 1.0),
            ],
            10,
            1,
            legacy_warning(model_id, "gpt-image-2"),
            config,
        ),
        ImageModelFamily::DallE3 => profile(
            adapter_id,
            family,
            generate,
            vec![
                select_parameter(
                    "size",
                    "1024x1024",
                    &["1024x1024", "1792x1024", "1024x1792"],
                ),
                select_parameter("quality", "standard", &["standard", "hd"]),
                number_parameter("n", 1.0, 1.0, 1.0),
            ],
            1,
            0,
            legacy_warning(model_id, "gpt-image-2"),
            config,
        ),
        ImageModelFamily::XaiImagine => profile(
            adapter_id,
            family,
            edit,
            vec![
                select_parameter(
                    "aspect_ratio",
                    "auto",
                    &[
                        "auto", "1:1", "3:4", "4:3", "9:16", "16:9", "2:3", "3:2", "9:19.5",
                        "19.5:9", "9:20", "20:9", "1:2", "2:1",
                    ],
                ),
                select_parameter("resolution", "1k", &["1k", "2k"]),
                number_parameter("n", 1.0, 10.0, 1.0),
            ],
            10,
            3,
            vec![],
            config,
        ),
        ImageModelFamily::Gemini31Flash => gemini_profile(
            adapter_id,
            family,
            &["512", "1K", "2K", "4K"],
            true,
            14,
            retired_gemini_warning(model_id),
            config,
        ),
        ImageModelFamily::Gemini31FlashLite => gemini_profile(
            adapter_id,
            family,
            &["1K"],
            false,
            14,
            retired_gemini_warning(model_id),
            config,
        ),
        ImageModelFamily::Gemini3Pro => gemini_profile(
            adapter_id,
            family,
            &["1K", "2K", "4K"],
            false,
            14,
            retired_gemini_warning(model_id),
            config,
        ),
        ImageModelFamily::Gemini25 => {
            let mut parameters = gemini_parameters(&[], false);
            parameters.retain(|parameter| parameter.key != "image_size");
            profile(
                adapter_id,
                family,
                edit,
                parameters,
                1,
                3,
                retired_gemini_warning(model_id),
                config,
            )
        }
        ImageModelFamily::Imagen4Standard | ImageModelFamily::Imagen4Ultra => profile(
            adapter_id,
            family,
            generate,
            imagen_parameters(true),
            4,
            0,
            imagen_warning(),
            config,
        ),
        ImageModelFamily::Imagen4Fast => profile(
            adapter_id,
            family,
            generate,
            imagen_parameters(false),
            4,
            0,
            imagen_warning(),
            config,
        ),
        ImageModelFamily::GlmImage => profile(
            adapter_id,
            family,
            generate,
            vec![
                string_parameter(
                    "size",
                    "1280x1280",
                    &[
                        "1280x1280",
                        "1568x1056",
                        "1056x1568",
                        "1472x1088",
                        "1088x1472",
                        "1728x960",
                        "960x1728",
                    ],
                ),
                select_parameter("quality", "hd", &["hd"]),
            ],
            1,
            0,
            vec![],
            config,
        ),
        ImageModelFamily::CogView => profile(
            adapter_id,
            family,
            generate,
            vec![
                string_parameter(
                    "size",
                    "1024x1024",
                    &[
                        "1024x1024",
                        "768x1344",
                        "864x1152",
                        "1344x768",
                        "1152x864",
                        "1440x720",
                        "720x1440",
                    ],
                ),
                select_parameter("quality", "standard", &["standard", "hd"]),
            ],
            1,
            0,
            vec![],
            config,
        ),
        ImageModelFamily::SiliconKolors => profile(
            adapter_id,
            family,
            generate,
            vec![
                select_parameter(
                    "size",
                    "1024x1024",
                    &["1024x1024", "960x1280", "768x1024", "720x1440", "720x1280"],
                ),
                number_parameter("n", 1.0, 4.0, 1.0),
                number_parameter("seed", 0.0, 9_999_999_999.0, 0.0),
                number_parameter("num_inference_steps", 1.0, 100.0, 20.0),
                number_parameter("guidance_scale", 0.0, 20.0, 7.5),
            ],
            4,
            0,
            vec![],
            config,
        ),
        ImageModelFamily::SiliconQwen => profile(
            adapter_id,
            family,
            generate,
            vec![
                select_parameter(
                    "size",
                    "1328x1328",
                    &[
                        "1328x1328",
                        "1664x928",
                        "928x1664",
                        "1472x1140",
                        "1140x1472",
                        "1584x1056",
                        "1056x1584",
                    ],
                ),
                number_parameter("seed", 0.0, 9_999_999_999.0, 0.0),
                number_parameter("num_inference_steps", 1.0, 100.0, 20.0),
            ],
            1,
            0,
            vec![],
            config,
        ),
        ImageModelFamily::SiliconQwenEdit => {
            let references = if model_id.to_ascii_lowercase().contains("2509") {
                3
            } else {
                1
            };
            profile(
                adapter_id,
                family,
                vec![ImageOperation::Edit],
                vec![
                    number_parameter("seed", 0.0, 9_999_999_999.0, 0.0),
                    number_parameter("num_inference_steps", 1.0, 100.0, 20.0),
                ],
                1,
                references,
                vec![],
                config,
            )
        }
        // Unreachable via resolve path: Unknown/Generic always map to an adapter default.
        // Kept for exhaustiveness if a caller forces these families.
        ImageModelFamily::Generic | ImageModelFamily::Unknown => {
            let default_family = adapter_default_family(adapter_id);
            let mut resolved = profile_for_family(adapter_id, model_id, default_family, config);
            if resolved.descriptor.warnings.is_empty() {
                resolved.descriptor.warnings =
                    fallback_profile_warning(model_id, param_profile_id_for_family(default_family));
            }
            resolved
        }
    }
}

fn profile(
    adapter_id: &str,
    family: ImageModelFamily,
    operations: Vec<ImageOperation>,
    parameters: Vec<ImageParameterDescriptor>,
    max_batch_size: u8,
    max_reference_images: u8,
    warnings: Vec<ImageModelWarning>,
    config: &ImageAdapterConfig,
) -> ImageModelProfile {
    let mut descriptor = ImageModelDescriptor {
        adapter_id: adapter_id.to_string(),
        operations,
        parameters,
        max_batch_size,
        max_reference_images,
        warnings,
    };
    apply_operation_overrides(&mut descriptor, config);
    ImageModelProfile {
        family,
        descriptor,
        api_mode: default_api_mode(family),
        official_docs: official_docs(family),
        audited_at: PROFILE_AUDITED_AT,
    }
}

fn default_api_mode(family: ImageModelFamily) -> ImageApiMode {
    match family {
        ImageModelFamily::Imagen4Standard
        | ImageModelFamily::Imagen4Ultra
        | ImageModelFamily::Imagen4Fast => ImageApiMode::Predict,
        ImageModelFamily::Gemini31Flash
        | ImageModelFamily::Gemini31FlashLite
        | ImageModelFamily::Gemini3Pro => ImageApiMode::Interactions,
        ImageModelFamily::Gemini25 => ImageApiMode::GenerateContent,
        _ => ImageApiMode::Auto,
    }
}

fn official_docs(family: ImageModelFamily) -> Option<&'static str> {
    match family {
        ImageModelFamily::OpenAiGpt2
        | ImageModelFamily::OpenAiGptLegacy
        | ImageModelFamily::DallE2
        | ImageModelFamily::DallE3 => Some(OPENAI_IMAGE_DOCS),
        ImageModelFamily::XaiImagine => Some(XAI_IMAGE_DOCS),
        ImageModelFamily::Gemini31Flash
        | ImageModelFamily::Gemini31FlashLite
        | ImageModelFamily::Gemini3Pro
        | ImageModelFamily::Gemini25 => Some(GEMINI_IMAGE_DOCS),
        ImageModelFamily::Imagen4Standard
        | ImageModelFamily::Imagen4Ultra
        | ImageModelFamily::Imagen4Fast => Some(IMAGEN_DOCS),
        ImageModelFamily::GlmImage | ImageModelFamily::CogView => Some(GLM_IMAGE_DOCS),
        ImageModelFamily::SiliconKolors
        | ImageModelFamily::SiliconQwen
        | ImageModelFamily::SiliconQwenEdit => Some(SILICONFLOW_IMAGE_DOCS),
        ImageModelFamily::Generic | ImageModelFamily::Unknown => None,
    }
}

fn apply_operation_overrides(descriptor: &mut ImageModelDescriptor, config: &ImageAdapterConfig) {
    if let Some(overrides) = &config.operation_overrides {
        descriptor
            .operations
            .retain(|operation| overrides.contains(operation));
    }
}

fn gemini_profile(
    adapter_id: &str,
    family: ImageModelFamily,
    sizes: &[&str],
    include_extreme_ratios: bool,
    max_reference_images: u8,
    warnings: Vec<ImageModelWarning>,
    config: &ImageAdapterConfig,
) -> ImageModelProfile {
    profile(
        adapter_id,
        family,
        vec![ImageOperation::Generate, ImageOperation::Edit],
        gemini_parameters(sizes, include_extreme_ratios),
        1,
        max_reference_images,
        warnings,
        config,
    )
}

fn gemini_parameters(
    sizes: &[&str],
    include_extreme_ratios: bool,
) -> Vec<ImageParameterDescriptor> {
    let ratios = if include_extreme_ratios {
        vec![
            "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "1:8", "8:1",
            "1:4", "4:1",
        ]
    } else {
        vec![
            "1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9",
        ]
    };
    let mut parameters = vec![
        select_parameter("aspect_ratio", "1:1", &ratios),
        select_parameter("output_format", "png", &["png", "jpeg"]),
    ];
    if !sizes.is_empty() {
        parameters.push(select_parameter("image_size", sizes[0], sizes));
    }
    parameters
}

fn imagen_parameters(include_size: bool) -> Vec<ImageParameterDescriptor> {
    let mut parameters = vec![
        select_parameter(
            "aspect_ratio",
            "1:1",
            &["1:1", "3:4", "4:3", "9:16", "16:9"],
        ),
        number_parameter("n", 1.0, 4.0, 1.0),
        select_parameter(
            "person_generation",
            "allow_adult",
            &["dont_allow", "allow_adult", "allow_all"],
        ),
    ];
    if include_size {
        parameters.push(select_parameter("image_size", "1K", &["1K", "2K"]));
    }
    parameters
}

fn legacy_warning(model_id: &str, replacement: &str) -> Vec<ImageModelWarning> {
    vec![ImageModelWarning {
        code: "legacy_model".into(),
        message: format!("{model_id} is a legacy image model; use {replacement} for new work."),
        deadline: None,
        replacement_model_id: Some(replacement.into()),
    }]
}

fn retired_gemini_warning(model_id: &str) -> Vec<ImageModelWarning> {
    let normalized = model_id.to_ascii_lowercase();
    if normalized.contains("preview") {
        let deadline = if normalized.contains("2.5-flash-image") {
            "2026-01-15"
        } else {
            "2026-06-25"
        };
        return vec![ImageModelWarning {
            code: "retired_model".into(),
            message: format!(
                "{model_id} is a retired Gemini preview model. The request is still allowed for compatible proxies. See {GEMINI_IMAGE_DOCS}."
            ),
            deadline: Some(deadline.into()),
            replacement_model_id: Some("gemini-3.1-flash-image".into()),
        }];
    }
    normalized.contains("2.5-flash-image").then(|| ImageModelWarning {
        code: "legacy_model".into(),
        message: format!(
            "{model_id} is a legacy Gemini image model. New integrations should use Gemini 3.1 Flash Lite Image. See {GEMINI_IMAGE_DOCS}."
        ),
        deadline: None,
        replacement_model_id: Some("gemini-3.1-flash-lite-image".into()),
    }).into_iter().collect()
}

fn imagen_warning() -> Vec<ImageModelWarning> {
    vec![ImageModelWarning {
        code: "deprecated_model".into(),
        message: format!(
            "Imagen 4 is deprecated and is scheduled to shut down. The request remains available for compatible endpoints. See {IMAGEN_DOCS}."
        ),
        deadline: Some("2026-08-17".into()),
        replacement_model_id: Some("gemini-3.1-flash-image".into()),
    }]
}

fn fallback_profile_warning(model_id: &str, profile_id: &str) -> Vec<ImageModelWarning> {
    vec![ImageModelWarning {
        code: "using_fallback_profile".into(),
        message: format!(
            "{model_id} has no verified image parameter profile; using fallback parameter preset `{profile_id}`."
        ),
        deadline: None,
        replacement_model_id: None,
    }]
}

fn select_parameter(key: &str, default: &str, options: &[&str]) -> ImageParameterDescriptor {
    ImageParameterDescriptor {
        key: key.into(),
        kind: ImageParameterKind::Select,
        default: default.into(),
        options: options
            .iter()
            .map(|value| Value::String((*value).into()))
            .collect(),
        min: None,
        max: None,
    }
}

fn string_parameter(key: &str, default: &str, options: &[&str]) -> ImageParameterDescriptor {
    ImageParameterDescriptor {
        key: key.into(),
        kind: ImageParameterKind::String,
        default: default.into(),
        options: options
            .iter()
            .map(|value| Value::String((*value).into()))
            .collect(),
        min: None,
        max: None,
    }
}

fn number_parameter(key: &str, min: f64, max: f64, default: f64) -> ImageParameterDescriptor {
    ImageParameterDescriptor {
        key: key.into(),
        kind: ImageParameterKind::Number,
        default: Value::from(default),
        options: vec![],
        min: Some(min),
        max: Some(max),
    }
}

fn optional_number_parameter(key: &str, min: f64, max: f64) -> ImageParameterDescriptor {
    ImageParameterDescriptor {
        key: key.into(),
        kind: ImageParameterKind::Number,
        default: Value::Null,
        options: vec![],
        min: Some(min),
        max: Some(max),
    }
}

pub(crate) fn resolved_gemini_api_mode(
    model_id: &str,
    config: &ImageAdapterConfig,
) -> ImageApiMode {
    if config.gemini_api_mode != ImageApiMode::Auto {
        return config.gemini_api_mode;
    }
    if config.endpoint.is_some() || config.edit_endpoint.is_some() {
        return ImageApiMode::GenerateContent;
    }
    match image_model_profile("gemini_images", model_id, config).api_mode {
        ImageApiMode::Auto => ImageApiMode::GenerateContent,
        mode => mode,
    }
}

pub(crate) fn validate_profile_request(
    adapter_id: &str,
    request: &ImageAdapterRequest,
    reference_count: usize,
    config: &ImageAdapterConfig,
) -> Result<()> {
    let profile = image_model_profile(adapter_id, &request.model, config);
    tracing::trace!(
        adapter_id,
        model_id = request.model,
        audited_at = profile.audited_at,
        official_docs = profile.official_docs.unwrap_or("custom"),
        "Validating image model profile"
    );
    let descriptor = &profile.descriptor;
    if !descriptor.operations.contains(&request.operation) {
        return invalid(
            request,
            "operation",
            format!("{:?}", request.operation),
            "one of the operations declared by this model",
        );
    }
    if request.n == 0 || request.n > descriptor.max_batch_size {
        return invalid(
            request,
            "n",
            request.n,
            format!("1..={}", descriptor.max_batch_size),
        );
    }
    if reference_count > descriptor.max_reference_images as usize {
        return invalid(
            request,
            "reference_images",
            reference_count,
            format!("0..={}", descriptor.max_reference_images),
        );
    }

    let allowed = descriptor
        .parameters
        .iter()
        .map(|parameter| parameter.key.as_str())
        .collect::<HashSet<_>>();
    for key in request
        .parameters
        .keys()
        .filter(|key| !key.starts_with("_aqbot_"))
    {
        if !allowed.contains(key.as_str()) {
            return invalid(
                request,
                key,
                "provided",
                "a parameter declared by this model",
            );
        }
    }
    for parameter in &descriptor.parameters {
        let Some(value) = request_parameter_value(request, &parameter.key) else {
            continue;
        };
        validate_parameter(request, parameter, value)?;
    }

    match profile.family {
        ImageModelFamily::OpenAiGpt2 | ImageModelFamily::OpenAiGptLegacy => {
            validate_gpt_image_request(request, profile.family == ImageModelFamily::OpenAiGpt2)
        }
        ImageModelFamily::XaiImagine => validate_xai_imagine_request(request, reference_count),
        ImageModelFamily::GlmImage => validate_custom_size(request, 1024, 2048, 32, 1 << 22),
        ImageModelFamily::CogView => validate_custom_size(request, 512, 2048, 16, 1 << 21),
        ImageModelFamily::Imagen4Standard
        | ImageModelFamily::Imagen4Ultra
        | ImageModelFamily::Imagen4Fast => {
            let estimated_tokens = aqbot_core::token_counter::estimate_tokens(&request.prompt);
            if estimated_tokens > 480 {
                invalid(
                    request,
                    "prompt_tokens_estimate",
                    estimated_tokens,
                    "0..=480",
                )
            } else {
                Ok(())
            }
        }
        _ => Ok(()),
    }
}

fn validate_xai_imagine_request(
    request: &ImageAdapterRequest,
    reference_count: usize,
) -> Result<()> {
    if request.operation == ImageOperation::Edit && reference_count == 0 {
        return invalid(
            request,
            "reference_images",
            reference_count,
            "1..=3 for image edit",
        );
    }
    Ok(())
}

fn request_parameter_value<'a>(request: &'a ImageAdapterRequest, key: &str) -> Option<Value> {
    match key {
        "size" => Some(request.size.clone().into()),
        "quality" => Some(request.quality.clone().into()),
        "output_format" => Some(request.output_format.clone().into()),
        "background" => request.background.clone().map(Value::String),
        "output_compression" => request.output_compression.map(Value::from),
        "n" => Some(Value::from(request.n)),
        _ => request.parameters.get(key).cloned(),
    }
}

fn validate_parameter(
    request: &ImageAdapterRequest,
    descriptor: &ImageParameterDescriptor,
    value: Value,
) -> Result<()> {
    if descriptor.kind != ImageParameterKind::String
        && !descriptor.options.is_empty()
        && !descriptor.options.contains(&value)
    {
        return invalid(
            request,
            &descriptor.key,
            value,
            format!("{:?}", descriptor.options),
        );
    }
    if descriptor.kind == ImageParameterKind::Number {
        let number = value.as_f64().ok_or_else(|| {
            AQBotError::Validation(format!(
                "Image model {} parameter {} must be numeric",
                request.model, descriptor.key
            ))
        })?;
        if descriptor.min.is_some_and(|min| number < min)
            || descriptor.max.is_some_and(|max| number > max)
        {
            return invalid(
                request,
                &descriptor.key,
                number,
                format!(
                    "{}..={}",
                    descriptor.min.unwrap_or(f64::NEG_INFINITY),
                    descriptor.max.unwrap_or(f64::INFINITY)
                ),
            );
        }
    }
    Ok(())
}

fn validate_gpt_image_request(request: &ImageAdapterRequest, is_gpt_image_2: bool) -> Result<()> {
    if is_gpt_image_2 && request.background.as_deref() == Some("transparent") {
        return invalid(request, "background", "transparent", "auto or opaque");
    }
    if request.output_compression.is_some()
        && !matches!(request.output_format.as_str(), "jpeg" | "webp")
    {
        return invalid(
            request,
            "output_compression",
            "provided",
            "only with output_format jpeg or webp",
        );
    }
    if !is_gpt_image_2 || request.size == "auto" {
        return Ok(());
    }
    let (width, height) = parse_size(&request.size).ok_or_else(|| {
        AQBotError::Validation(format!(
            "Image model {} parameter size={} must be auto or WIDTHxHEIGHT",
            request.model, request.size
        ))
    })?;
    if width > 3840 || height > 3840 || width % 16 != 0 || height % 16 != 0 {
        return invalid(
            request,
            "size",
            &request.size,
            "edges <= 3840 and divisible by 16",
        );
    }
    let (long, short) = if width >= height {
        (width, height)
    } else {
        (height, width)
    };
    let pixels = u64::from(width) * u64::from(height);
    if long > short.saturating_mul(3) || !(655_360..=8_294_400).contains(&pixels) {
        return invalid(
            request,
            "size",
            &request.size,
            "ratio <= 3:1 and 655360..=8294400 pixels",
        );
    }
    Ok(())
}

fn validate_custom_size(
    request: &ImageAdapterRequest,
    min_edge: u32,
    max_edge: u32,
    multiple: u32,
    max_pixels: u64,
) -> Result<()> {
    let (width, height) = parse_size(&request.size).ok_or_else(|| {
        AQBotError::Validation(format!(
            "Image model {} parameter size={} must use WIDTHxHEIGHT",
            request.model, request.size
        ))
    })?;
    let pixels = u64::from(width) * u64::from(height);
    if width < min_edge
        || height < min_edge
        || width > max_edge
        || height > max_edge
        || width % multiple != 0
        || height % multiple != 0
        || pixels > max_pixels
    {
        return invalid(
            request,
            "size",
            &request.size,
            format!(
                "edges {min_edge}..={max_edge}, divisible by {multiple}, pixels <= {max_pixels}"
            ),
        );
    }
    Ok(())
}

fn parse_size(size: &str) -> Option<(u32, u32)> {
    let (width, height) = size.split_once('x')?;
    Some((width.parse().ok()?, height.parse().ok()?))
}

fn invalid(
    request: &ImageAdapterRequest,
    field: &str,
    actual: impl std::fmt::Display,
    expected: impl std::fmt::Display,
) -> Result<()> {
    Err(AQBotError::Validation(format!(
        "Image model {} parameter {}={} is invalid; expected {}",
        request.model, field, actual, expected
    )))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(model: &str) -> ImageAdapterRequest {
        ImageAdapterRequest {
            operation: ImageOperation::Generate,
            model: model.into(),
            prompt: "draw".into(),
            n: 1,
            size: "1024x1024".into(),
            quality: "auto".into(),
            output_format: "png".into(),
            background: None,
            output_compression: None,
            images: vec![],
            mask: None,
            parameters: serde_json::Map::new(),
        }
    }

    #[test]
    fn profiles_are_model_specific() {
        let config = ImageAdapterConfig::default();
        let gpt2 = image_model_profile("openai_images", "gpt-image-2", &config);
        let dalle3 = image_model_profile("openai_images", "dall-e-3", &config);
        assert!(gpt2.descriptor.operations.contains(&ImageOperation::Edit));
        assert_eq!(dalle3.descriptor.operations, vec![ImageOperation::Generate]);
        assert_eq!(dalle3.descriptor.max_batch_size, 1);
        assert_eq!(gpt2.audited_at, PROFILE_AUDITED_AT);
        assert_eq!(gpt2.official_docs, Some(OPENAI_IMAGE_DOCS));
    }

    #[test]
    fn openai_compat_proxy_model_uses_gpt_image_fallback_params() {
        let config = ImageAdapterConfig::default();
        let profile = image_model_profile("openai_images", "gemini-3.1-flash-image", &config);
        assert_eq!(profile.family, ImageModelFamily::OpenAiGpt2);
        assert!(profile
            .descriptor
            .operations
            .contains(&ImageOperation::Edit));
        assert!(profile
            .descriptor
            .parameters
            .iter()
            .any(|parameter| parameter.key == "size"));
        assert_eq!(
            profile.descriptor.warnings[0].code,
            "using_fallback_profile"
        );

        let mut request = request("gemini-3.1-flash-image");
        request.size = "1024x1024".into();
        request.quality = "auto".into();
        assert!(validate_profile_request("openai_images", &request, 0, &config).is_ok());
    }

    #[test]
    fn explicit_param_profile_selects_builtin_schema() {
        let config = ImageAdapterConfig {
            param_profile: Some("gemini_3_1_flash".into()),
            ..Default::default()
        };
        let profile = image_model_profile("openai_images", "my-custom-relay", &config);
        assert_eq!(profile.family, ImageModelFamily::Gemini31Flash);
        assert!(profile
            .descriptor
            .parameters
            .iter()
            .any(|parameter| parameter.key == "aspect_ratio"));
        assert!(profile.descriptor.warnings.is_empty());
    }

    #[test]
    fn validation_rejects_model_specific_invalid_values() {
        let config = ImageAdapterConfig::default();
        let mut gpt2 = request("gpt-image-2");
        gpt2.quality = "hd".into();
        assert!(validate_profile_request("openai_images", &gpt2, 0, &config).is_err());

        let mut xai = request("grok-imagine-image");
        xai.parameters
            .insert("resolution".into(), Value::String("4k".into()));
        assert!(validate_profile_request("xai_images", &xai, 0, &config).is_err());

        let mut imagen = request("imagen-4.0-generate-001");
        imagen.prompt = "x".repeat(2_000);
        assert!(validate_profile_request("gemini_images", &imagen, 0, &config).is_err());
    }

    #[test]
    fn xai_imagine_profile_is_verified_for_aliases_and_requires_edit_references() {
        let config = ImageAdapterConfig::default();
        for model in [
            "grok-image",
            "grok-imagine-image",
            "grok-imagine-image-quality",
        ] {
            let profile = image_model_profile("xai_images", model, &config);
            assert_eq!(profile.family, ImageModelFamily::XaiImagine);
            assert!(profile.descriptor.warnings.is_empty());
            assert_eq!(profile.official_docs, Some(XAI_IMAGE_DOCS));
            assert!(validate_profile_request("xai_images", &request(model), 0, &config).is_ok());

            let mut edit = request(model);
            edit.operation = ImageOperation::Edit;
            assert!(validate_profile_request("xai_images", &edit, 0, &config).is_err());
            assert!(validate_profile_request("xai_images", &edit, 1, &config).is_ok());
            assert!(validate_profile_request("xai_images", &edit, 3, &config).is_ok());
            assert!(validate_profile_request("xai_images", &edit, 4, &config).is_err());
        }
    }

    #[test]
    fn official_profile_matrix_exposes_only_model_specific_parameters() {
        let config = ImageAdapterConfig::default();
        let parameter = |adapter: &str, model: &str, key: &str| {
            image_model_profile(adapter, model, &config)
                .descriptor
                .parameters
                .into_iter()
                .find(|parameter| parameter.key == key)
        };

        let gpt2_quality = parameter("openai_images", "gpt-image-2", "quality").unwrap();
        assert_eq!(
            gpt2_quality.options,
            ["auto", "low", "medium", "high"]
                .into_iter()
                .map(Value::from)
                .collect::<Vec<_>>()
        );
        assert!(parameter("openai_images", "dall-e-3", "output_format").is_none());

        let flash_ratios =
            parameter("gemini_images", "gemini-3.1-flash-image", "aspect_ratio").unwrap();
        let lite_ratios = parameter(
            "gemini_images",
            "gemini-3.1-flash-lite-image",
            "aspect_ratio",
        )
        .unwrap();
        assert_eq!(flash_ratios.options.len(), 14);
        assert_eq!(lite_ratios.options.len(), 10);
        assert!(parameter("gemini_images", "gemini-2.5-flash-image", "image_size").is_none());

        let imagen = image_model_profile("gemini_images", "imagen-4.0-fast-generate-001", &config);
        assert_eq!(imagen.descriptor.operations, vec![ImageOperation::Generate]);
        assert!(imagen
            .descriptor
            .parameters
            .iter()
            .all(|parameter| parameter.key != "image_size"));

        let qwen_edit =
            image_model_profile("siliconflow_images", "Qwen/Qwen-Image-Edit-2509", &config);
        assert_eq!(qwen_edit.descriptor.operations, vec![ImageOperation::Edit]);
        assert_eq!(qwen_edit.descriptor.max_reference_images, 3);
        assert!(qwen_edit
            .descriptor
            .parameters
            .iter()
            .all(|parameter| parameter.key != "size"));
    }

    #[test]
    fn gemini_auto_mode_routes_current_legacy_and_imagen_models() {
        let config = ImageAdapterConfig::default();
        assert_eq!(
            resolved_gemini_api_mode("gemini-3.1-flash-image", &config),
            ImageApiMode::Interactions
        );
        assert_eq!(
            resolved_gemini_api_mode("gemini-2.5-flash-image", &config),
            ImageApiMode::GenerateContent
        );
        assert_eq!(
            resolved_gemini_api_mode("imagen-4.0-generate-001", &config),
            ImageApiMode::Predict
        );
    }
}
