//! Official ONNX Runtime shared libraries, loaded at runtime.
//!
//! Static pyke binaries fail to link on GitHub release targets (Windows CRT
//! mix, Linux glibc/libstdc++ mismatch, missing Intel macOS builds, and Linux
//! ARM cross-compile of `ort-sys`'s download build-script). `ort` is therefore
//! built with `load-dynamic` and this module fetches Microsoft's CPU package.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use aqbot_core::error::{coded_error, Result};
use sha2::{Digest, Sha256};

pub const ORT_VERSION: &str = "1.22.0";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct OrtPackage {
    pub os: &'static str,
    pub arch: &'static str,
    pub archive_name: &'static str,
    pub sha256: &'static str,
    pub size_bytes: u64,
    pub format: ArchiveFormat,
    pub primary_lib: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ArchiveFormat {
    TarGz,
    Zip,
}

const PACKAGES: &[OrtPackage] = &[
    OrtPackage {
        os: "linux",
        arch: "x86_64",
        archive_name: "onnxruntime-linux-x64-1.22.0.tgz",
        sha256: "8344d55f93d5bc5021ce342db50f62079daf39aaafb5d311a451846228be49b3",
        size_bytes: 7_798_730,
        format: ArchiveFormat::TarGz,
        primary_lib: "libonnxruntime.so.1.22.0",
    },
    OrtPackage {
        os: "linux",
        arch: "aarch64",
        archive_name: "onnxruntime-linux-aarch64-1.22.0.tgz",
        sha256: "bb76395092d150b52c7092dc6b8f2fe4d80f0f3bf0416d2f269193e347e24702",
        size_bytes: 6_849_865,
        format: ArchiveFormat::TarGz,
        primary_lib: "libonnxruntime.so.1.22.0",
    },
    OrtPackage {
        os: "macos",
        arch: "aarch64",
        archive_name: "onnxruntime-osx-arm64-1.22.0.tgz",
        sha256: "cab6dcbd77e7ec775390e7b73a8939d45fec3379b017c7cb74f5b204c1a1cc07",
        size_bytes: 25_943_843,
        format: ArchiveFormat::TarGz,
        primary_lib: "libonnxruntime.1.22.0.dylib",
    },
    OrtPackage {
        os: "macos",
        arch: "x86_64",
        archive_name: "onnxruntime-osx-x86_64-1.22.0.tgz",
        sha256: "e4ec94a7696de74fb1b12846569aa94e499958af6ffa186022cfde16c9d617f0",
        size_bytes: 27_889_590,
        format: ArchiveFormat::TarGz,
        primary_lib: "libonnxruntime.1.22.0.dylib",
    },
    OrtPackage {
        os: "windows",
        arch: "x86_64",
        archive_name: "onnxruntime-win-x64-1.22.0.zip",
        sha256: "174c616efc0271194488642a72f1a514e01487da4dfe84c49296d66e40ebe0da",
        size_bytes: 72_368_545,
        format: ArchiveFormat::Zip,
        primary_lib: "onnxruntime.dll",
    },
    OrtPackage {
        os: "windows",
        arch: "aarch64",
        archive_name: "onnxruntime-win-arm64-1.22.0.zip",
        sha256: "7008f7ff82f8e7de563a22f2b590e08e706a1289eba606b93de2b56edfb1e04b",
        size_bytes: 73_055_483,
        format: ArchiveFormat::Zip,
        primary_lib: "onnxruntime.dll",
    },
];

static ORT_READY: OnceLock<()> = OnceLock::new();
static INSTALL_LOCK: OnceLock<tokio::sync::Mutex<()>> = OnceLock::new();

pub fn package_for(os: &str, arch: &str) -> Result<&'static OrtPackage> {
    PACKAGES
        .iter()
        .find(|package| package.os == os && package.arch == arch)
        .ok_or_else(|| {
            coded_error(
                "ONNXRUNTIME_UNSUPPORTED_TARGET",
                serde_json::json!({ "os": os, "arch": arch }),
            )
        })
}

pub fn current_package() -> Result<&'static OrtPackage> {
    package_for(std::env::consts::OS, std::env::consts::ARCH)
}

pub fn download_urls(package: &OrtPackage) -> Vec<String> {
    vec![
        format!(
            "https://github.com/microsoft/onnxruntime/releases/download/v{ORT_VERSION}/{}",
            package.archive_name
        ),
        format!(
            "https://cdn.npmmirror.com/binaries/onnxruntime/v{ORT_VERSION}/{}",
            package.archive_name
        ),
    ]
}

pub fn install_dir(config_home: &Path) -> PathBuf {
    config_home
        .join("runtime")
        .join("onnxruntime")
        .join(ORT_VERSION)
}

pub fn primary_lib_path(config_home: &Path, package: &OrtPackage) -> PathBuf {
    install_dir(config_home).join(package.primary_lib)
}

pub fn is_installed(config_home: &Path, package: &OrtPackage) -> bool {
    let path = primary_lib_path(config_home, package);
    path.is_file()
        && std::fs::metadata(&path)
            .map(|meta| meta.len() > 0)
            .unwrap_or(false)
}

pub fn override_dylib_path() -> Option<PathBuf> {
    std::env::var_os("ORT_DYLIB_PATH").map(PathBuf::from)
}

pub fn resolve_installed(config_home: &Path) -> Result<PathBuf> {
    if let Some(override_path) = override_dylib_path() {
        if override_path.is_file() {
            return Ok(override_path);
        }
        return Err(coded_error(
            "ONNXRUNTIME_DYLIB_MISSING",
            serde_json::json!({ "path": override_path.display().to_string() }),
        ));
    }
    let package = current_package()?;
    let path = primary_lib_path(config_home, package);
    if path.is_file() {
        Ok(path)
    } else {
        Err(coded_error(
            "ONNXRUNTIME_DYLIB_MISSING",
            serde_json::json!({ "path": path.display().to_string() }),
        ))
    }
}

pub fn is_runtime_lib_member(archive_path: &str) -> bool {
    let normalized = archive_path.replace('\\', "/");
    let file_name = normalized.rsplit('/').next().unwrap_or(normalized.as_str());
    if normalized.split('/').any(|part| part == "..")
        || file_name.is_empty()
        || file_name.ends_with(".pdb")
        || file_name.ends_with(".lib")
        || file_name.ends_with(".dSYM")
        || normalized.contains(".dSYM/")
        || normalized.contains("/cmake/")
        || normalized.contains("/pkgconfig/")
        || normalized.contains("/include/")
    {
        return false;
    }
    file_name.starts_with("onnxruntime") || file_name.starts_with("libonnxruntime")
}

fn member_file_name(archive_path: &str) -> Option<String> {
    let normalized = archive_path.replace('\\', "/");
    if normalized.split('/').any(|part| part == "..") {
        return None;
    }
    let file_name = normalized.rsplit('/').next().unwrap_or("");
    if file_name.is_empty() || file_name == "." {
        None
    } else {
        Some(file_name.to_string())
    }
}

pub fn extract_archive(archive: &Path, dest_dir: &Path, package: &OrtPackage) -> Result<()> {
    fs::create_dir_all(dest_dir)?;
    match package.format {
        ArchiveFormat::Zip => extract_zip(archive, dest_dir)?,
        ArchiveFormat::TarGz => extract_tar_gz(archive, dest_dir)?,
    }
    let primary = dest_dir.join(package.primary_lib);
    if !primary.is_file() {
        return Err(coded_error(
            "ONNXRUNTIME_EXTRACT_MISSING_LIB",
            serde_json::json!({
                "expected": package.primary_lib,
                "dir": dest_dir.display().to_string()
            }),
        ));
    }
    Ok(())
}

fn extract_zip(archive: &Path, dest_dir: &Path) -> Result<()> {
    let file = File::open(archive)?;
    let mut zip = zip::ZipArchive::new(file).map_err(io_error)?;
    for index in 0..zip.len() {
        let mut entry = zip.by_index(index).map_err(io_error)?;
        if !entry.is_file() {
            continue;
        }
        let name = entry.name().to_string();
        if !is_runtime_lib_member(&name) {
            continue;
        }
        let Some(file_name) = member_file_name(&name) else {
            continue;
        };
        let dest = dest_dir.join(&file_name);
        let mut out = File::create(&dest)?;
        io::copy(&mut entry, &mut out)?;
    }
    Ok(())
}

fn extract_tar_gz(archive: &Path, dest_dir: &Path) -> Result<()> {
    let file = File::open(archive)?;
    let decoder = flate2::read::GzDecoder::new(file);
    let mut tar = tar::Archive::new(decoder);
    for entry in tar.entries().map_err(io_error)? {
        let mut entry = entry.map_err(io_error)?;
        if !entry.header().entry_type().is_file() {
            continue;
        }
        let name = entry
            .path()
            .map_err(io_error)?
            .to_string_lossy()
            .replace('\\', "/");
        if !is_runtime_lib_member(&name) {
            continue;
        }
        let Some(file_name) = member_file_name(&name) else {
            continue;
        };
        let dest = dest_dir.join(&file_name);
        let mut out = File::create(&dest)?;
        io::copy(&mut entry, &mut out)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = fs::metadata(&dest)?.permissions();
            perms.set_mode(0o755);
            fs::set_permissions(&dest, perms)?;
        }
    }
    Ok(())
}

fn io_error(error: impl ToString) -> aqbot_core::error::AQBotError {
    coded_error(
        "ONNXRUNTIME_ARCHIVE_IO",
        serde_json::json!({ "reason": error.to_string() }),
    )
}

pub fn sha256_file(path: &Path) -> Result<String> {
    let mut file = File::open(path)?;
    let mut hasher = Sha256::new();
    let mut buf = [0u8; 32 * 1024];
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

pub fn verify_archive(path: &Path, package: &OrtPackage) -> Result<()> {
    let hash = sha256_file(path)?;
    if hash != package.sha256 {
        let _ = fs::remove_file(path);
        return Err(coded_error(
            "ONNXRUNTIME_ARCHIVE_HASH_MISMATCH",
            serde_json::json!({
                "expected": package.sha256,
                "actual": hash,
                "archive": package.archive_name
            }),
        ));
    }
    Ok(())
}

pub async fn ensure_installed(config_home: &Path) -> Result<PathBuf> {
    let _install = INSTALL_LOCK
        .get_or_init(|| tokio::sync::Mutex::new(()))
        .lock()
        .await;
    if let Some(override_path) = override_dylib_path() {
        if override_path.is_file() {
            return Ok(override_path);
        }
        return Err(coded_error(
            "ONNXRUNTIME_DYLIB_MISSING",
            serde_json::json!({ "path": override_path.display().to_string() }),
        ));
    }
    let package = current_package()?;
    let dest = primary_lib_path(config_home, package);
    if is_installed(config_home, package) {
        return Ok(dest);
    }
    download_and_extract(config_home, package).await?;
    Ok(dest)
}

async fn download_and_extract(config_home: &Path, package: &OrtPackage) -> Result<()> {
    let dir = install_dir(config_home);
    fs::create_dir_all(&dir)?;
    let archive_path = dir.join(package.archive_name);
    if !(archive_path.is_file()
        && sha256_file(&archive_path).ok().as_deref() == Some(package.sha256))
    {
        download_archive(&archive_path, package).await?;
        verify_archive(&archive_path, package)?;
    }
    extract_archive(&archive_path, &dir, package)?;
    let _ = fs::remove_file(&archive_path);
    Ok(())
}

async fn download_archive(dest: &Path, package: &OrtPackage) -> Result<()> {
    let client = reqwest::Client::builder()
        .user_agent("AQBot/1.0")
        .build()
        .map_err(|error| {
            coded_error(
                "ONNXRUNTIME_DOWNLOAD_FAILED",
                serde_json::json!({ "reason": error.to_string() }),
            )
        })?;
    let partial = dest.with_extension("partial");
    let mut last_error = String::from("no_url");
    for url in download_urls(package) {
        match download_url(&client, &url, &partial).await {
            Ok(()) => {
                fs::rename(&partial, dest)?;
                return Ok(());
            }
            Err(error) => {
                last_error = error.to_string();
                let _ = fs::remove_file(&partial);
            }
        }
    }
    Err(coded_error(
        "ONNXRUNTIME_DOWNLOAD_FAILED",
        serde_json::json!({
            "archive": package.archive_name,
            "reason": last_error
        }),
    ))
}

async fn download_url(
    client: &reqwest::Client,
    url: &str,
    dest: &Path,
) -> std::result::Result<(), String> {
    use futures::StreamExt;
    let response = client.get(url).send().await.map_err(|e| e.to_string())?;
    if !response.status().is_success() {
        return Err(format!("HTTP {}", response.status()));
    }
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut stream = response.bytes_stream();
    let mut out = File::create(dest).map_err(|e| e.to_string())?;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        out.write_all(&chunk).map_err(|e| e.to_string())?;
    }
    out.flush().map_err(|e| e.to_string())?;
    Ok(())
}

pub fn init_ort(dylib: &Path) -> Result<()> {
    if ORT_READY.get().is_some() {
        return Ok(());
    }
    let _ = ort::init_from(dylib)
        .map_err(|error| {
            coded_error(
                "ONNXRUNTIME_LOAD_FAILED",
                serde_json::json!({
                    "path": dylib.display().to_string(),
                    "reason": error.to_string()
                }),
            )
        })?
        .commit();
    let _ = ORT_READY.set(());
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    #[test]
    fn maps_all_six_release_targets() {
        let expected = [
            (
                "linux",
                "x86_64",
                "onnxruntime-linux-x64-1.22.0.tgz",
                "libonnxruntime.so.1.22.0",
            ),
            (
                "linux",
                "aarch64",
                "onnxruntime-linux-aarch64-1.22.0.tgz",
                "libonnxruntime.so.1.22.0",
            ),
            (
                "macos",
                "aarch64",
                "onnxruntime-osx-arm64-1.22.0.tgz",
                "libonnxruntime.1.22.0.dylib",
            ),
            (
                "macos",
                "x86_64",
                "onnxruntime-osx-x86_64-1.22.0.tgz",
                "libonnxruntime.1.22.0.dylib",
            ),
            (
                "windows",
                "x86_64",
                "onnxruntime-win-x64-1.22.0.zip",
                "onnxruntime.dll",
            ),
            (
                "windows",
                "aarch64",
                "onnxruntime-win-arm64-1.22.0.zip",
                "onnxruntime.dll",
            ),
        ];
        let mut hashes = std::collections::HashSet::new();
        for (os, arch, archive, primary) in expected {
            let package = package_for(os, arch).expect(archive);
            assert_eq!(package.archive_name, archive);
            assert_eq!(package.primary_lib, primary);
            assert_eq!(package.sha256.len(), 64);
            assert!(package.size_bytes > 1_000_000);
            assert!(hashes.insert(package.sha256));
            let urls = download_urls(package);
            assert!(urls[0].contains("github.com/microsoft/onnxruntime"));
            assert!(urls[1].contains("npmmirror.com"));
            assert!(urls.iter().all(|url| url.ends_with(archive)));
        }
    }

    #[test]
    fn rejects_unknown_targets() {
        let err = package_for("linux", "riscv64").unwrap_err().to_string();
        assert!(err.contains("ONNXRUNTIME_UNSUPPORTED_TARGET"));
    }

    #[test]
    fn filters_runtime_libs_and_skips_debug_symbols() {
        assert!(is_runtime_lib_member(
            "onnxruntime-linux-x64-1.22.0/lib/libonnxruntime.so.1.22.0"
        ));
        assert!(is_runtime_lib_member(
            "onnxruntime-linux-x64-1.22.0/lib/libonnxruntime_providers_shared.so"
        ));
        assert!(is_runtime_lib_member(
            "onnxruntime-win-x64-1.22.0/lib/onnxruntime.dll"
        ));
        assert!(!is_runtime_lib_member(
            "onnxruntime-win-x64-1.22.0/lib/onnxruntime.pdb"
        ));
        assert!(!is_runtime_lib_member(
            "onnxruntime-osx-arm64-1.22.0/lib/libonnxruntime.1.22.0.dylib.dSYM/Contents/Info.plist"
        ));
        assert!(!is_runtime_lib_member(
            "onnxruntime-linux-x64-1.22.0/include/onnxruntime_c_api.h"
        ));
        assert!(!is_runtime_lib_member("../onnxruntime.dll"));
        assert!(!is_runtime_lib_member(
            "onnxruntime-win-x64-1.22.0/lib/../escape.dll"
        ));
    }

    #[test]
    fn extracts_zip_libs_and_blocks_path_escape() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("ort.zip");
        {
            let file = File::create(&archive).unwrap();
            let mut zip = zip::ZipWriter::new(file);
            let options = zip::write::SimpleFileOptions::default();
            zip.start_file("onnxruntime-win-x64-1.22.0/lib/onnxruntime.dll", options)
                .unwrap();
            zip.write_all(b"primary-dll").unwrap();
            zip.start_file(
                "onnxruntime-win-x64-1.22.0/lib/onnxruntime_providers_shared.dll",
                options,
            )
            .unwrap();
            zip.write_all(b"shared-dll").unwrap();
            zip.start_file("onnxruntime-win-x64-1.22.0/lib/onnxruntime.pdb", options)
                .unwrap();
            zip.write_all(b"pdb").unwrap();
            zip.start_file("../escape.dll", options).unwrap();
            zip.write_all(b"nope").unwrap();
            zip.finish().unwrap();
        }
        let dest = dir.path().join("out");
        let package = package_for("windows", "x86_64").unwrap();
        extract_archive(&archive, &dest, package).unwrap();
        assert_eq!(
            fs::read(dest.join("onnxruntime.dll")).unwrap(),
            b"primary-dll"
        );
        assert_eq!(
            fs::read(dest.join("onnxruntime_providers_shared.dll")).unwrap(),
            b"shared-dll"
        );
        assert!(!dest.join("onnxruntime.pdb").exists());
        assert!(!dir.path().join("escape.dll").exists());
    }

    #[test]
    fn extracts_tar_gz_primary_lib() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("ort.tgz");
        {
            let file = File::create(&archive).unwrap();
            let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
            let mut tar = tar::Builder::new(encoder);
            let mut header = tar::Header::new_gnu();
            let data = b"so-bytes";
            header.set_size(data.len() as u64);
            header.set_mode(0o644);
            header.set_cksum();
            tar.append_data(
                &mut header,
                "onnxruntime-linux-x64-1.22.0/lib/libonnxruntime.so.1.22.0",
                data.as_slice(),
            )
            .unwrap();
            tar.finish().unwrap();
        }
        let dest = dir.path().join("out");
        let package = package_for("linux", "x86_64").unwrap();
        extract_archive(&archive, &dest, package).unwrap();
        assert_eq!(
            fs::read(dest.join("libonnxruntime.so.1.22.0")).unwrap(),
            b"so-bytes"
        );
    }

    #[test]
    fn reports_missing_when_primary_lib_absent() {
        let dir = tempfile::tempdir().unwrap();
        let package = package_for("linux", "x86_64").unwrap();
        assert!(!is_installed(dir.path(), package));
        assert!(primary_lib_path(dir.path(), package)
            .display()
            .to_string()
            .contains("runtime/onnxruntime/1.22.0"));
    }

    #[test]
    fn verify_archive_rejects_wrong_hash() {
        let dir = tempfile::tempdir().unwrap();
        let archive = dir.path().join("bad.tgz");
        fs::write(&archive, b"not-an-archive").unwrap();
        let package = package_for("linux", "x86_64").unwrap();
        let err = verify_archive(&archive, package).unwrap_err().to_string();
        assert!(err.contains("ONNXRUNTIME_ARCHIVE_HASH_MISMATCH"));
        assert!(!archive.exists());
    }
}
