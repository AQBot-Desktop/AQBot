use super::*;

fn encoded(image: &RgbaImage, format: ImageFormat) -> String {
    let mut bytes = Cursor::new(Vec::new());
    DynamicImage::ImageRgba8(image.clone())
        .to_rgb8()
        .write_to(&mut bytes, format)
        .unwrap();
    base64::engine::general_purpose::STANDARD.encode(bytes.into_inner())
}

#[test]
fn tray_icon_normalization_keeps_aspect_ratio_and_transparent_padding() {
    let image = RgbaImage::from_pixel(100, 50, image::Rgba([240, 10, 20, 255]));
    for (format, mime) in [
        (ImageFormat::Png, "image/png"),
        (ImageFormat::Jpeg, "image/jpeg"),
        (ImageFormat::WebP, "image/webp"),
    ] {
        let bytes = normalize(&encoded(&image, format), mime).unwrap();
        let normalized = image::load_from_memory(&bytes).unwrap().to_rgba8();
        assert_eq!(normalized.dimensions(), (64, 64));
        assert_eq!(normalized.get_pixel(32, 0).0[3], 0);
        assert_eq!(normalized.get_pixel(32, 32).0[3], 255);
        assert!(stored_image(&bytes).is_ok());
    }
}

#[test]
fn tray_icon_rejects_bad_mime_corruption_and_size_limits() {
    let image = RgbaImage::new(4, 4);
    let png = encoded(&image, ImageFormat::Png);
    assert!(normalize(&png, "image/jpeg")
        .unwrap_err()
        .contains("tray_icon_format"));
    assert!(normalize("invalid", "image/png").is_err());
    assert!(normalize("", "image/png").is_err());
    assert!(
        normalize(&"A".repeat(MAX_BYTES.div_ceil(3) * 4 + 1), "image/png")
            .unwrap_err()
            .contains("tray_icon_size")
    );
    let large = encoded(&RgbaImage::new(4097, 1), ImageFormat::Png);
    assert!(normalize(&large, "image/png").is_err());
}

#[test]
fn tray_icon_preserves_source_alpha() {
    let image = RgbaImage::from_pixel(64, 64, image::Rgba([10, 20, 30, 100]));
    let mut bytes = Cursor::new(Vec::new());
    image.write_to(&mut bytes, ImageFormat::Png).unwrap();
    let data = base64::engine::general_purpose::STANDARD.encode(bytes.into_inner());
    let normalized = normalize(&data, "image/png").unwrap();
    assert_eq!(
        image::load_from_memory(&normalized)
            .unwrap()
            .to_rgba8()
            .get_pixel(32, 32)
            .0[3],
        100
    );
}

#[test]
fn tray_icon_rejects_animation_and_non_normalized_stored_images() {
    // Valid 1x1 APNG with one animation frame, generated from PNG chunks.
    let apng = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACGFjVEwAAAABAAAAALQt6aAAAAAaZmNUTAAAAAAAAAABAAAAAQAAAAAAAAAAAAEACgAAWn8w0AAAAA1JREFUeJxj+M/A8B8ABQAB/4mZPR0AAAAASUVORK5CYII=";
    assert!(normalize(apng, "image/png")
        .unwrap_err()
        .contains("animation"));
    let data = encoded(&RgbaImage::new(1, 1), ImageFormat::Png);
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .unwrap();
    assert!(stored_image(&bytes).unwrap_err().contains("64x64"));
}
