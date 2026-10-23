use std::{env, path::PathBuf, process::Command};
fn main() {
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
