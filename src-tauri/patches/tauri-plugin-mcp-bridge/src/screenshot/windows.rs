use super::{Screenshot, ScreenshotError};
use tauri::{Runtime, WebviewWindow};

/// Windows-specific screenshot implementation using WebView2's CapturePreview
///
/// This implementation captures only the visible viewport.
/// WebView2's CapturePreview API naturally captures just the viewport.
pub fn capture_viewport<R: Runtime>(
    window: &WebviewWindow<R>,
) -> Result<Screenshot, ScreenshotError> {
    #[cfg(target_os = "windows")]
    {
        use std::sync::mpsc;
        use webview2_com::{
            CapturePreviewCompletedHandler,
            Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
        };
        use windows::Win32::Foundation::HGLOBAL;
        use windows::Win32::System::Com::IStream;
        use windows::Win32::System::Com::StructuredStorage::CreateStreamOnHGlobal;

        let (tx, rx) = mpsc::channel::<Result<Screenshot, ScreenshotError>>();

        window
            .with_webview(move |webview| {
                unsafe {
                    // Get ICoreWebView2 from Tauri's webview handle
                    let controller = webview.controller();
                    let core_webview = controller.CoreWebView2().unwrap();

                    // Create memory stream for PNG output
                    let stream: IStream = CreateStreamOnHGlobal(HGLOBAL::default(), true).unwrap();
                    let stream_clone = stream.clone();

                    // Use webview2-com's pre-built completion handler
                    let handler = CapturePreviewCompletedHandler::create(Box::new(move |result| {
                        let screenshot_result = match result {
                            Ok(()) => {
                                // SAFETY: read_stream_to_vec requires the stream to be valid,
                                // which is guaranteed by the CapturePreview completion handler
                                match read_stream_to_vec(&stream_clone) {
                                    Ok(data) => Ok(Screenshot { data }),
                                    Err(e) => Err(e),
                                }
                            }
                            Err(e) => Err(ScreenshotError::CaptureFailed(format!(
                                "CapturePreview failed: {}",
                                e
                            ))),
                        };
                        let _ = tx.send(screenshot_result);
                        Ok(())
                    }));

                    // Capture viewport as PNG
                    let _ = core_webview.CapturePreview(
                        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                        &stream,
                        &handler,
                    );
                }
            })
            .map_err(|e| {
                ScreenshotError::CaptureFailed(format!("Failed to access webview: {}", e))
            })?;

        // Wait for result
        match rx.recv_timeout(std::time::Duration::from_secs(10)) {
            Ok(result) => result,
            Err(_) => Err(ScreenshotError::Timeout),
        }
    }

    #[cfg(not(target_os = "windows"))]
    {
        Err(ScreenshotError::PlatformUnsupported)
    }
}

/// Read all bytes from an IStream
///
/// # Safety
/// The stream must be valid and readable.
#[cfg(target_os = "windows")]
unsafe fn read_stream_to_vec(
    stream: &windows::Win32::System::Com::IStream,
) -> Result<Vec<u8>, ScreenshotError> {
    use windows::Win32::System::Com::{STREAM_SEEK_END, STREAM_SEEK_SET};

    // Seek to beginning
    stream
        .Seek(0, STREAM_SEEK_SET, None)
        .map_err(|e| ScreenshotError::CaptureFailed(format!("Failed to seek stream: {}", e)))?;

    // Get stream size by seeking to end
    let mut end_pos: u64 = 0;
    stream
        .Seek(0, STREAM_SEEK_END, Some(&mut end_pos))
        .map_err(|e| ScreenshotError::CaptureFailed(format!("Failed to get stream size: {}", e)))?;

    // Seek back to start
    stream
        .Seek(0, STREAM_SEEK_SET, None)
        .map_err(|e| ScreenshotError::CaptureFailed(format!("Failed to seek stream: {}", e)))?;

    // Read data
    let mut buffer = vec![0u8; end_pos as usize];
    let mut bytes_read: u32 = 0;
    stream
        .Read(
            buffer.as_mut_ptr() as *mut _,
            buffer.len() as u32,
            Some(&mut bytes_read),
        )
        .ok()
        .map_err(|e| ScreenshotError::CaptureFailed(format!("Failed to read stream: {}", e)))?;

    buffer.truncate(bytes_read as usize);
    Ok(buffer)
}
