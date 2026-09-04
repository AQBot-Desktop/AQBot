//! Windows-specific utilities: native error dialogs for fatal startup failures.

use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::Globalization::GetUserDefaultLocaleName;
use windows_sys::Win32::System::Registry::{
    RegGetValueW, HKEY_LOCAL_MACHINE, RRF_RT_REG_DWORD, RRF_RT_REG_SZ, RRF_SUBKEY_WOW6464KEY,
};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    MessageBoxW, IDOK, MB_ICONERROR, MB_ICONWARNING, MB_OK, MB_OKCANCEL,
};

/// Encode a Rust string as a null-terminated UTF-16 vector for Win32 APIs.
fn to_wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Show a native Windows MessageBox with an error icon.
pub fn show_error_dialog(title: &str, message: &str) {
    show_dialog(title, message, MB_OK | MB_ICONERROR);
}

pub fn show_warning_dialog(title: &str, message: &str) {
    show_dialog(title, message, MB_OK | MB_ICONWARNING);
}

fn show_dialog(title: &str, message: &str, style: u32) -> i32 {
    let wide_title = to_wide(title);
    let wide_msg = to_wide(message);
    let result = unsafe { MessageBoxW(0 as HWND, wide_msg.as_ptr(), wide_title.as_ptr(), style) };
    if result == 0 {
        tracing::error!(error = %std::io::Error::last_os_error(), "Could not show Windows startup dialog");
    }
    result
}

/// Show a native Windows MessageBox with a warning icon and OK/Cancel buttons.
/// Returns `true` if the user clicked OK.
pub fn show_warning_ok_cancel(title: &str, message: &str) -> bool {
    show_dialog(title, message, MB_OKCANCEL | MB_ICONWARNING) == IDOK
}

pub fn system_locale() -> Result<String, std::io::Error> {
    let mut buffer = [0u16; 256];
    let length = unsafe { GetUserDefaultLocaleName(buffer.as_mut_ptr(), buffer.len() as i32) };
    if length == 0 {
        return Err(std::io::Error::last_os_error());
    }
    String::from_utf16(&buffer[..length as usize - 1])
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

/// Registry build numbers are unaffected by compatibility-mode version shims.
pub fn system_version() -> Result<String, std::io::Error> {
    let major = registry_version_number("CurrentMajorVersionNumber")?;
    let minor = registry_version_number("CurrentMinorVersionNumber")?;
    let revision = registry_version_number("UBR")?;
    let mut buffer = [0u16; 64];
    let mut bytes = std::mem::size_of_val(&buffer) as u32;
    registry_version_value(
        "CurrentBuildNumber",
        RRF_RT_REG_SZ,
        buffer.as_mut_ptr().cast(),
        &mut bytes,
    )?;
    let utf16 = &buffer[..bytes as usize / 2];
    let build = String::from_utf16(utf16.strip_suffix(&[0]).unwrap_or(utf16))
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    Ok(format!("{major}.{minor}.{build}.{revision}"))
}

fn registry_version_number(name: &str) -> Result<u32, std::io::Error> {
    let mut value = 0u32;
    let mut bytes = std::mem::size_of_val(&value) as u32;
    registry_version_value(
        name,
        RRF_RT_REG_DWORD,
        (&mut value as *mut u32).cast(),
        &mut bytes,
    )?;
    Ok(value)
}

fn registry_version_value(
    name: &str,
    kind: u32,
    buffer: *mut std::ffi::c_void,
    bytes: &mut u32,
) -> Result<(), std::io::Error> {
    let path = to_wide(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion");
    let name = to_wide(name);
    let status = unsafe {
        RegGetValueW(
            HKEY_LOCAL_MACHINE,
            path.as_ptr(),
            name.as_ptr(),
            kind | RRF_SUBKEY_WOW6464KEY,
            std::ptr::null_mut(),
            buffer,
            bytes,
        )
    };
    if status != 0 {
        return Err(std::io::Error::from_raw_os_error(status as i32));
    }
    Ok(())
}
