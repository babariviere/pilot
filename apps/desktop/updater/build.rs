use std::{env, path::PathBuf, process::Command};
fn main() {
    build_input_identity();
    for variable in [
        "PILOT_NEXT_UPDATER_PUBLIC_KEY",
        "PILOT_NEXT_UPDATER_REPOSITORY",
        "PILOT_NEXT_UPDATER_APPLICATION_ID",
        "PILOT_NEXT_UPDATER_BUILD",
        "PILOT_NEXT_UPDATER_CODE_REQUIREMENT",
    ] {
        println!("cargo:rerun-if-env-changed={variable}");
    }
    println!("cargo:rerun-if-changed=native/platform.m");
    if env::var_os("CARGO_FEATURE_NATIVE_LINUX").is_some() {
        assert_eq!(env::var("CARGO_CFG_TARGET_OS").unwrap(), "linux");
    }
    if env::var_os("CARGO_FEATURE_NATIVE_MACOS").is_none() {
        return;
    }
    assert_eq!(env::var("CARGO_CFG_TARGET_OS").unwrap(), "macos");
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let object = output.join("platform.o");
    assert!(
        Command::new("/usr/bin/clang")
            .args([
                "-fobjc-arc",
                "-Wall",
                "-Wextra",
                "-Werror",
                "-mmacosx-version-min=15.0",
                "-c",
                "native/platform.m",
                "-o"
            ])
            .arg(&object)
            .status()
            .unwrap()
            .success()
    );
    assert!(
        Command::new("/usr/bin/ar")
            .arg("crs")
            .arg(output.join("libpilot_next_updater.a"))
            .arg(object)
            .status()
            .unwrap()
            .success()
    );
    println!("cargo:rustc-link-search=native={}", output.display());
    println!("cargo:rustc-link-lib=static=pilot_next_updater");
    println!("cargo:rustc-link-lib=framework=Foundation");
    println!("cargo:rustc-link-lib=framework=Security");
}

// Build evidence only, never update authority. Read by the offline input builder
// from both compiled executables before any native startup or transaction.
fn build_input_identity() {
    for name in ["PILOT_BUILD_SOURCE", "PILOT_BUILD_RECIPE"] {
        println!("cargo:rerun-if-env-changed={name}");
        println!(
            "cargo:rustc-env={name}={}",
            env::var(name).unwrap_or_default()
        );
    }
    for name in ["TARGET", "PROFILE"] {
        println!(
            "cargo:rustc-env=PILOT_BUILD_{name}={}",
            env::var(name).unwrap()
        );
    }
    let compiler = Command::new(env::var_os("RUSTC").expect("Cargo RUSTC"))
        .arg("-vV")
        .output()
        .expect("compiler identity");
    assert!(compiler.status.success(), "compiler identity failed");
    // JSON preserves the exact multiline version without Cargo directive lines.
    let version = String::from_utf8(compiler.stdout).expect("compiler version UTF-8");
    let version = version.trim_end().replace('\n', "|");
    println!("cargo:rustc-env=PILOT_BUILD_COMPILER={version}");
}
