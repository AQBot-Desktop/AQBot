use image::RgbaImage;
use windows::Win32::Graphics::Gdi::{
    BitBlt, CreateCompatibleBitmap, CreateCompatibleDC, DeleteDC, DeleteObject, GetDC, GetDIBits,
    ReleaseDC, SelectObject, BITMAPINFO, BITMAPINFOHEADER, BI_RGB, CAPTUREBLT, DIB_RGB_COLORS,
    HBITMAP, HDC, HGDIOBJ, SRCCOPY,
};

use super::{geometry::CaptureTarget, validate_dimensions, CaptureError};

struct CaptureResources {
    screen: HDC,
    memory: HDC,
    bitmap: HBITMAP,
    previous: HGDIOBJ,
}

impl Drop for CaptureResources {
    fn drop(&mut self) {
        // All handles are owned by this capture; the selected bitmap must be restored first.
        unsafe {
            if !self.previous.is_invalid() {
                if SelectObject(self.memory, self.previous).is_invalid() {
                    tracing::warn!("Failed to restore screenshot GDI selection");
                }
            }
            if !self.bitmap.is_invalid() {
                if !DeleteObject(self.bitmap.into()).as_bool() {
                    tracing::warn!("Failed to release screenshot GDI bitmap");
                }
            }
            if !self.memory.is_invalid() {
                if !DeleteDC(self.memory).as_bool() {
                    tracing::warn!("Failed to release screenshot GDI memory context");
                }
            }
            if !self.screen.is_invalid() {
                if ReleaseDC(None, self.screen) == 0 {
                    tracing::warn!("Failed to release screenshot GDI screen context");
                }
            }
        }
    }
}

pub(super) fn capture_monitor(target: &CaptureTarget) -> Result<RgbaImage, CaptureError> {
    validate_dimensions(target.width, target.height)?;
    let width = i32::try_from(target.width).map_err(CaptureError::failed)?;
    let height = i32::try_from(target.height).map_err(CaptureError::failed)?;
    // Tauri initializes per-monitor DPI awareness; these bounds are physical pixels.
    unsafe {
        let mut resources = CaptureResources {
            screen: GetDC(None),
            memory: HDC::default(),
            bitmap: HBITMAP::default(),
            previous: HGDIOBJ::default(),
        };
        if resources.screen.is_invalid() {
            return Err(native_error("GetDC"));
        }
        resources.memory = CreateCompatibleDC(Some(resources.screen));
        if resources.memory.is_invalid() {
            return Err(native_error("CreateCompatibleDC"));
        }
        resources.bitmap = CreateCompatibleBitmap(resources.screen, width, height);
        if resources.bitmap.is_invalid() {
            return Err(native_error("CreateCompatibleBitmap"));
        }
        resources.previous = SelectObject(resources.memory, resources.bitmap.into());
        if resources.previous.is_invalid() {
            return Err(native_error("SelectObject"));
        }
        BitBlt(
            resources.memory,
            0,
            0,
            width,
            height,
            Some(resources.screen),
            target.x,
            target.y,
            SRCCOPY | CAPTUREBLT,
        )
        .map_err(CaptureError::failed)?;
        // GetDIBits requires the bitmap not to be selected into a device context.
        if SelectObject(resources.memory, resources.previous).is_invalid() {
            return Err(native_error("SelectObject restore"));
        }
        resources.previous = HGDIOBJ::default();
        let mut info = BITMAPINFO {
            bmiHeader: BITMAPINFOHEADER {
                biSize: std::mem::size_of::<BITMAPINFOHEADER>() as u32,
                biWidth: width,
                biHeight: -height,
                biPlanes: 1,
                biBitCount: 32,
                biCompression: BI_RGB.0,
                ..Default::default()
            },
            ..Default::default()
        };
        let mut pixels = vec![0_u8; target.width as usize * target.height as usize * 4];
        let copied = GetDIBits(
            resources.screen,
            resources.bitmap,
            0,
            target.height,
            Some(pixels.as_mut_ptr().cast()),
            &mut info,
            DIB_RGB_COLORS,
        );
        if copied != height {
            return Err(native_error("GetDIBits"));
        }
        for pixel in pixels.chunks_exact_mut(4) {
            pixel.swap(0, 2);
            pixel[3] = 255;
        }
        RgbaImage::from_raw(target.width, target.height, pixels)
            .ok_or_else(|| CaptureError::failed("The captured bitmap has an invalid size"))
    }
}

fn native_error(operation: &str) -> CaptureError {
    CaptureError::failed(format!("{operation}: {}", std::io::Error::last_os_error()))
}
