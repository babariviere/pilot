use std::path::PathBuf;
fn main() {
    let root = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR").unwrap())
        .parent()
        .unwrap()
        .to_owned();
    let vendor = root.join(".tools/quickjs-ng-0.17.0");
    assert!(
        vendor.join("quickjs.c").is_file(),
        "run python3 scripts/prepare-visual-worker.py first"
    );
    let mut c = cc::Build::new();
    c.include(&vendor)
        .include(root.join("../macos/Sources/PilotVisualEngine/include"))
        .define("_GNU_SOURCE", None)
        .define("localtime_r", Some("gmtime_r"))
        .flag("-funsigned-char")
        .opt_level(2)
        .warnings(false);
    for file in ["quickjs.c", "dtoa.c", "libregexp.c", "libunicode.c"] {
        let file = vendor.join(file);
        println!("cargo:rerun-if-changed={}", file.display());
        c.file(file);
    }
    c.file("engine.c").compile("desktop_visual_engine");
    println!("cargo:rerun-if-changed=engine.c");
    println!(
        "cargo:rerun-if-changed={}",
        root.join("../macos/Sources/PilotVisualEngine/pilot_visual_engine.c")
            .display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        root.join("../../packages/artifacts/src/visual/runtime.js")
            .display()
    );
}
