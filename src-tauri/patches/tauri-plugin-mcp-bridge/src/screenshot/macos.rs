use super::{Screenshot, ScreenshotError};
use tauri::{Runtime, WebviewWindow};

/// macOS-specific screenshot implementation using WKWebView's takeSnapshot
///
/// This implementation captures only the visible viewport, not the full document.
/// It uses the native WKWebView takeSnapshot API to get a high-quality screenshot.
pub fn capture_viewport<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<Screenshot, ScreenshotError> {
    #[cfg(target_os = "macos")]
    {
        use block2::RcBlock;
        use objc2_app_kit::NSImage;
        use objc2_foundation::NSError;
        use objc2_web_kit::{WKSnapshotConfiguration, WKWebView};
        use std::sync::mpsc;
        use std::sync::{Arc, Mutex};

        let (tx, rx) = mpsc::channel::<Result<Screenshot, ScreenshotError>>();
        let tx = Arc::new(Mutex::new(Some(tx)));

        // Use Tauri's with_webview to access the platform-specific webview
        window
            .with_webview(move |webview| {
                unsafe {
                    // Get the WKWebView from Tauri's webview handle
                    let wkwebview: &WKWebView = &*(webview.inner() as *const _ as *const WKWebView);

                    // Create snapshot configuration (nil means capture visible viewport)
                    let config = WKSnapshotConfiguration::new();

                    // Create completion handler block
                    let tx_clone = tx.clone();
                    let handler = RcBlock::new(move |image: *mut NSImage, error: *mut NSError| {
                        if let Some(tx) = tx_clone.lock().unwrap().take() {
                            if !error.is_null() {
                                let err = &*error;
                                let desc = err.localizedDescription();
                                let error_string = desc.to_string();
                                let _ = tx.send(Err(ScreenshotError::CaptureFailed(error_string)));
                            } else if !image.is_null() {
                                let img = &*image;
                                // Convert NSImage to PNG data
                                match convert_nsimage_to_png(img) {
                                    Ok(data) => {
                                        let _ = tx.send(Ok(Screenshot { data }));
                                    }
                                    Err(e) => {
                                        let _ = tx.send(Err(e));
                                    }
                                }
                            } else {
                                let _ = tx.send(Err(ScreenshotError::CaptureFailed(
                                    "No image returned from snapshot".to_string(),
                                )));
                            }
                        }
                    });

                    // Take snapshot
                    wkwebview
                        .takeSnapshotWithConfiguration_completionHandler(Some(&config), &handler);
                }
            })
            .map_err(|e| {
                ScreenshotError::CaptureFailed(format!("Failed to access webview: {e}"))
            })?;

        // Wait for result
        match rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(result) => result,
            Err(_) => Err(ScreenshotError::Timeout),
        }
    }

    #[cfg(not(target_os = "macos"))]
    {
        Err(ScreenshotError::PlatformUnsupported)
    }
}

#[cfg(target_os = "macos")]
unsafe fn convert_nsimage_to_png(
    image: &objc2_app_kit::NSImage,
) -> Result<Vec<u8>, ScreenshotError> {
    use objc2_app_kit::{NSBitmapImageFileType, NSBitmapImageRep};
    use objc2_foundation::NSDictionary;

    // Get TIFF representation
    let tiff_data = image.TIFFRepresentation().ok_or_else(|| {
        ScreenshotError::EncodeFailed("Failed to get TIFF representation".to_string())
    })?;

    // Create bitmap representation from TIFF data
    let bitmap = NSBitmapImageRep::imageRepWithData(&tiff_data).ok_or_else(|| {
        ScreenshotError::EncodeFailed("Failed to create bitmap representation".to_string())
    })?;

    // Convert to PNG
    let properties = NSDictionary::new();
    let png_data = bitmap
        .representationUsingType_properties(NSBitmapImageFileType::PNG, &properties)
        .ok_or_else(|| ScreenshotError::EncodeFailed("Failed to create PNG data".to_string()))?;

    // Convert NSData to Vec<u8>
    let length = png_data.len();
    let bytes = png_data.bytes();
    let data = std::slice::from_raw_parts(bytes.as_ptr(), length).to_vec();

    Ok(data)
}
