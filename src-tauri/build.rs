use std::{
    env,
    path::{Path, PathBuf},
    process::Command,
};

fn main() {
    // Tauri embeds this file into macOS development binaries at compile time.
    println!("cargo:rerun-if-changed=icons/icon.icns");
    configure_macos_swift_linker();
    tauri_build::build()
}

fn configure_macos_swift_linker() {
    if env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }

    let swiftc = command_stdout("xcrun", &["--find", "swiftc"])
        .unwrap_or_else(|error| panic!("failed to locate swiftc with xcrun: {error}"));
    let swift_lib_dir = swift_library_dir(Path::new(swiftc.trim())).unwrap_or_else(|error| {
        panic!("failed to locate macOS Swift compatibility libraries: {error}")
    });

    println!("cargo:rustc-link-search=native={}", swift_lib_dir.display());
    println!("cargo:rerun-if-env-changed=DEVELOPER_DIR");
}

fn command_stdout(program: &str, args: &[&str]) -> Result<String, String> {
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_owned());
    }
    String::from_utf8(output.stdout).map_err(|error| error.to_string())
}

fn swift_library_dir(swiftc: &Path) -> Result<PathBuf, String> {
    let bin_dir = swiftc
        .parent()
        .ok_or_else(|| format!("swiftc path has no parent: {}", swiftc.display()))?;
    let library_dir = bin_dir.join("../lib/swift/macosx");
    let required = [
        "libswiftCompatibility56.a",
        "libswiftCompatibilityConcurrency.a",
        "libswiftCompatibilityPacks.a",
    ];
    let missing: Vec<_> = required
        .iter()
        .filter(|name| !library_dir.join(name).is_file())
        .copied()
        .collect();
    if !missing.is_empty() {
        return Err(format!(
            "{} is missing {}",
            library_dir.display(),
            missing.join(", ")
        ));
    }
    library_dir
        .canonicalize()
        .map_err(|error| error.to_string())
}
