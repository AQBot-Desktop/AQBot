use std::io::Cursor;

use base64::Engine;
use image::{DynamicImage, ImageDecoder, ImageFormat, Limits, RgbaImage};

pub const MAX_BYTES: usize = 5 * 1024 * 1024;
const MAX_DIMENSION: u32 = 4096;
const ICON_SIZE: u32 = 64;

fn limits() -> Limits {
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_DIMENSION);
    limits.max_image_height = Some(MAX_DIMENSION);
    limits.max_alloc = Some(64 * 1024 * 1024);
    limits
}

fn decode_static(bytes: &[u8], mime_type: &str) -> Result<DynamicImage, String> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES {
        return Err("tray_icon_size".into());
    }
    let format =
        image::guess_format(bytes).map_err(|error| format!("tray_icon_invalid: {error}"))?;
    let expected_mime = match format {
        ImageFormat::Png => "image/png",
        ImageFormat::Jpeg => "image/jpeg",
        ImageFormat::WebP => "image/webp",
        _ => return Err("tray_icon_format".into()),
    };
    if mime_type != expected_mime {
        return Err("tray_icon_format".into());
    }
    let cursor = Cursor::new(bytes);
    let operation = || -> image::ImageResult<DynamicImage> {
        let mut decoder: Box<dyn ImageDecoder> = match format {
            ImageFormat::Png => {
                let png = image::codecs::png::PngDecoder::with_limits(cursor, limits())?;
                if png.is_apng()? {
                    return Err(image::ImageError::Unsupported(
                        image::error::UnsupportedError::from_format_and_kind(
                            format.into(),
                            image::error::UnsupportedErrorKind::GenericFeature("animation".into()),
                        ),
                    ));
                }
                Box::new(png)
            }
            ImageFormat::WebP => {
                let webp = image::codecs::webp::WebPDecoder::new(cursor)?;
                if webp.has_animation() {
                    return Err(image::ImageError::Unsupported(
                        image::error::UnsupportedError::from_format_and_kind(
                            format.into(),
                            image::error::UnsupportedErrorKind::GenericFeature("animation".into()),
                        ),
                    ));
                }
                Box::new(webp)
            }
            ImageFormat::Jpeg => Box::new(image::codecs::jpeg::JpegDecoder::new(cursor)?),
            _ => unreachable!("formats are checked above"),
        };
        decoder.set_limits(limits())?;
        let mut allocation_limits = limits();
        allocation_limits.reserve(decoder.total_bytes())?;
        let orientation = decoder.orientation()?;
        let mut image = DynamicImage::from_decoder(decoder)?;
        image.apply_orientation(orientation);
        Ok(image)
    };
    operation().map_err(|error| format!("tray_icon_invalid: {error}"))
}

pub fn normalize(data: &str, mime_type: &str) -> Result<Vec<u8>, String> {
    if data.len() > MAX_BYTES.div_ceil(3) * 4 {
        return Err("tray_icon_size".into());
    }
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| format!("tray_icon_invalid: {error}"))?;
    let image = decode_static(&bytes, mime_type)?;
    let resized = image
        .resize(ICON_SIZE, ICON_SIZE, image::imageops::FilterType::Lanczos3)
        .to_rgba8();
    let mut square = RgbaImage::new(ICON_SIZE, ICON_SIZE);
    image::imageops::overlay(
        &mut square,
        &resized,
        ((ICON_SIZE - resized.width()) / 2).into(),
        ((ICON_SIZE - resized.height()) / 2).into(),
    );
    let mut output = Cursor::new(Vec::new());
    square
        .write_to(&mut output, ImageFormat::Png)
        .map_err(|error| error.to_string())?;
    Ok(output.into_inner())
}

pub fn stored_image(bytes: &[u8]) -> Result<tauri::image::Image<'static>, String> {
    let image = decode_static(bytes, "image/png")?.to_rgba8();
    if image.dimensions() != (ICON_SIZE, ICON_SIZE) {
        return Err("tray_icon_invalid: stored image must be 64x64".into());
    }
    Ok(tauri::image::Image::new_owned(
        image.into_raw(),
        ICON_SIZE,
        ICON_SIZE,
    ))
}

#[cfg(test)]
#[path = "tray_icon_image_tests.rs"]
mod tests;
