use image::RgbaImage;
use x11rb::{
    connection::Connection,
    image::{Image, PixelLayout},
    protocol::xproto::ConnectionExt,
};

use super::{geometry::CaptureTarget, validate_dimensions, CaptureError};

pub(super) fn ensure_x11() -> Result<(), CaptureError> {
    if is_wayland(
        std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
        std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
    ) {
        return Err(CaptureError::new(
            "capture_unavailable",
            "Screenshot shortcuts currently require an X11 session",
        ));
    }
    Ok(())
}

fn is_wayland(session_type: Option<&str>, display: Option<&str>) -> bool {
    session_type.is_some_and(|value| value.eq_ignore_ascii_case("wayland"))
        || display.is_some_and(|value| !value.is_empty())
}

pub(super) fn capture_monitor(target: &CaptureTarget) -> Result<RgbaImage, CaptureError> {
    ensure_x11()?;
    validate_dimensions(target.width, target.height)?;
    let (connection, screen_index) = x11rb::connect(None).map_err(CaptureError::failed)?;
    let screen =
        connection.setup().roots.get(screen_index).ok_or_else(|| {
            CaptureError::new("capture_unavailable", "The X11 screen is unavailable")
        })?;
    let geometry = connection
        .get_geometry(screen.root)
        .map_err(CaptureError::failed)?
        .reply()
        .map_err(CaptureError::failed)?;
    let right = i64::from(target.x) + i64::from(target.width);
    let bottom = i64::from(target.y) + i64::from(target.height);
    if target.x < 0
        || target.y < 0
        || right > i64::from(geometry.width)
        || bottom > i64::from(geometry.height)
    {
        return Err(CaptureError::new(
            "capture_unavailable",
            "The monitor is outside the X11 root drawable",
        ));
    }
    let (captured, visual_id) = Image::get(
        &connection,
        screen.root,
        i16::try_from(target.x).map_err(CaptureError::failed)?,
        i16::try_from(target.y).map_err(CaptureError::failed)?,
        u16::try_from(target.width).map_err(CaptureError::failed)?,
        u16::try_from(target.height).map_err(CaptureError::failed)?,
    )
    .map_err(CaptureError::failed)?;
    let visual = screen
        .allowed_depths
        .iter()
        .flat_map(|depth| &depth.visuals)
        .find(|visual| visual.visual_id == visual_id)
        .ok_or_else(|| CaptureError::failed("The X11 screenshot visual is unavailable"))?;
    let layout = PixelLayout::from_visual_type(*visual).map_err(CaptureError::failed)?;
    Ok(RgbaImage::from_fn(target.width, target.height, |x, y| {
        let (red, green, blue) = layout.decode(captured.get_pixel(x as u16, y as u16));
        image::Rgba([(red >> 8) as u8, (green >> 8) as u8, (blue >> 8) as u8, 255])
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wayland_is_rejected_even_when_xwayland_exposes_display() {
        assert!(is_wayland(Some("wayland"), None));
        assert!(is_wayland(Some("x11"), Some("wayland-0")));
        assert!(!is_wayland(Some("x11"), None));
    }
}
