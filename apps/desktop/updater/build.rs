use std::{env, path::PathBuf, process::Command};

fn run(command: &mut Command) {
    assert!(
        command
            .status()
            .expect("launch native build tool")
            .success(),
        "native build failed"
    );
}

fn main() {
    println!("cargo:rerun-if-env-changed=PILOT_NEXT_SPARKLE_FRAMEWORK_DIR");
    println!("cargo:rerun-if-changed=native/bridge.m");
    println!("cargo:rerun-if-changed=native/bridge.h");
    if env::var_os("CARGO_FEATURE_NATIVE_MACOS").is_none() {
        return;
    }
    assert_eq!(
        env::var("CARGO_CFG_TARGET_OS").unwrap(),
        "macos",
        "native-macos requires macOS"
    );
    let directory =
        PathBuf::from(env::var_os("PILOT_NEXT_SPARKLE_FRAMEWORK_DIR").expect(
            "native-macos requires an explicit directory containing pinned Sparkle.framework",
        ));
    assert!(
        directory.is_absolute(),
        "framework directory must be absolute"
    );
    let plist = directory.join("Sparkle.framework/Resources/Info.plist");
    let version = Command::new("/usr/libexec/PlistBuddy")
        .args(["-c", "Print :CFBundleShortVersionString"])
        .arg(plist)
        .output()
        .expect("read framework version");
    assert!(
        version.status.success() && version.stdout == b"2.8.1\n",
        "only Sparkle 2.8.1 has been reviewed"
    );
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let object = output.join("bridge.o");
    run(Command::new("/usr/bin/clang")
        .args([
            "-fobjc-arc",
            "-fblocks",
            "-Wall",
            "-Wextra",
            "-Werror",
            "-Wno-unused-parameter",
            "-mmacosx-version-min=15.0",
            "-c",
            "native/bridge.m",
            "-F",
        ])
        .arg(&directory)
        .arg("-o")
        .arg(&object));
    run(Command::new("/usr/bin/ar")
        .arg("crs")
        .arg(output.join("libpilot_next_updater.a"))
        .arg(object));
    println!("cargo:rustc-link-search=native={}", output.display());
    println!("cargo:rustc-link-search=framework={}", directory.display());
    println!("cargo:rustc-link-lib=static=pilot_next_updater");
    for framework in ["Foundation", "AppKit", "Sparkle"] {
        println!("cargo:rustc-link-lib=framework={framework}");
    }
    // Packaging must embed the complete framework and independently sign nested code.
    println!("cargo:rustc-link-arg=-Wl,-rpath,@executable_path/../Frameworks");
}
