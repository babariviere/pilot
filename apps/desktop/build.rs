//! Linux build support for the Pilot Next desktop app.
//!
//! GPUI's Linux backend links a few system libraries by their unversioned
//! development names (`-lxcb`, `-lxkbcommon`, `-lxkbcommon-x11`). Many
//! distributions ship only the runtime objects (`libxcb.so.1`,
//! `libxkbcommon.so.0`, ...) unless the matching `-devel` package is
//! installed, and the final link then fails with `unable to find library
//! -lxcb` even though the library is present at runtime.
//!
//! When the unversioned name is missing but a matching versioned runtime
//! object is installed, this build script links a private directory of
//! symlinks to those objects and adds it to the link search path. The
//! symlinked objects keep their original `SONAME`, so the runtime still
//! resolves the real system library. Nothing is installed, no system
//! directory is written and the symlinks live in Cargo's own `OUT_DIR`.
//!
//! This is a convenience for hosts without root access. Installing the
//! distribution's development packages remains the supported path; the build
//! prints the matching package names when it has to fall back.

use std::{
    collections::BTreeSet,
    path::{Path, PathBuf},
};

/// System libraries the Linux link needs, by unversioned link name.
///
/// Only libraries that no `pkg-config` module provides are listed here.
/// Font and font-config libraries come from their own build scripts, which
/// fail early with a clearer message when the development files are absent.
const LINK_NAMES: &[&str] = &["xcb", "xkbcommon", "xkbcommon-x11"];

/// Package hints per distribution family, shown when a fallback is used.
const PACKAGE_HINTS: &[(&str, &[&str])] = &[
    ("fedora", &["libxcb-devel", "libxkbcommon-devel"]),
    ("debian", &["libxcb1-dev", "libxkbcommon-dev"]),
    ("arch", &["libxcb", "libxkbcommon"]),
    ("suse", &["libxcb-devel", "libxkbcommon-devel"]),
];

fn main() {
    diagnostic_source();
    println!("cargo:rerun-if-changed=build.rs");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("linux") {
        return;
    }

    let out_dir = PathBuf::from(std::env::var("OUT_DIR").expect("OUT_DIR"));
    let shim_dir = out_dir.join("native-libs");
    // Start from an empty directory. A stale entry would shadow a library that
    // another build script provides through pkg-config.
    let _ = std::fs::remove_dir_all(&shim_dir);
    let search_dirs = search_dirs();
    let mut linked = Vec::new();
    let mut missing = Vec::new();

    for name in LINK_NAMES {
        match find_library(name, &search_dirs) {
            Library::Found => continue,
            Library::Missing => {
                // No runtime object either: the distribution package is required.
                missing.push(*name);
                continue;
            }
            Library::Versioned(path) => {
                if std::fs::create_dir_all(&shim_dir).is_err() {
                    missing.push(*name);
                    continue;
                }
                let link = shim_dir.join(format!("lib{name}.so"));
                let _ = std::fs::remove_file(&link);
                if std::os::unix::fs::symlink(&path, &link).is_err() {
                    missing.push(*name);
                    continue;
                }
                linked.push((*name, path));
            }
        }
    }

    if !linked.is_empty() {
        println!("cargo:rustc-link-search=native={}", shim_dir.display());
    }

    if !missing.is_empty() {
        println!(
            "cargo:warning=missing system libraries for the Linux link: {}. Install the development packages for your distribution (for example {}).",
            missing.join(", "),
            PACKAGE_HINTS
                .iter()
                .map(|(_, packages)| packages.join(" "))
                .collect::<Vec<_>>()
                .join(", ")
        );
    }

    if !linked.is_empty() {
        let mut names = BTreeSet::new();
        for (name, path) in &linked {
            names.insert(format!("lib{name}.so -> {}", path.display()));
        }
        println!(
            "cargo:warning=linked system libraries through Cargo's private native-libs directory because the development symlinks are missing: {}",
            names.into_iter().collect::<Vec<_>>().join(", ")
        );
    }
}

// A reproducible desktop-source fingerprint, not a claim about the signed payload
// or a jj/Git commit (shared working copies need not have a matching Git HEAD).
fn diagnostic_source() {
    use sha2::{Digest, Sha256};
    fn collect(dir: &std::path::Path, files: &mut Vec<PathBuf>) {
        for entry in std::fs::read_dir(dir).expect("desktop sources") {
            let path = entry.expect("source entry").path();
            if path.is_dir() {
                collect(&path, files);
            } else if path.extension().is_some_and(|ext| ext == "rs") {
                files.push(path);
            }
        }
    }
    let mut files = vec![
        "Cargo.toml".into(),
        "Cargo.lock".into(),
        "build.rs".into(),
        "../../package.json".into(),
    ];
    collect(std::path::Path::new("src"), &mut files);
    files.sort();
    println!("cargo:rerun-if-changed=src");
    let mut digest = Sha256::new();
    for path in files {
        println!("cargo:rerun-if-changed={}", path.display());
        digest.update(path.to_string_lossy().as_bytes());
        digest.update([0]);
        digest.update(std::fs::read(path).expect("fingerprinted source"));
        digest.update([0]);
    }
    println!(
        "cargo:rustc-env=PILOT_DESKTOP_SOURCE_SHA256={:x}",
        digest.finalize()
    );
}

enum Library {
    /// The unversioned development object is installed; nothing to do.
    Found,
    /// Neither the development object nor a usable runtime object was found.
    Missing,
    /// Only a versioned runtime object is installed.
    Versioned(PathBuf),
}

/// Directories searched for system libraries, most specific first.
fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = Vec::new();
    if let Ok(library_path) = std::env::var("LIBRARY_PATH") {
        dirs.extend(std::env::split_paths(&library_path));
    }
    for dir in [
        "/usr/lib64",
        "/lib64",
        "/usr/lib/x86_64-linux-gnu",
        "/usr/lib/aarch64-linux-gnu",
        "/usr/lib",
        "/lib",
        "/usr/local/lib64",
        "/usr/local/lib",
    ] {
        dirs.push(PathBuf::from(dir));
    }
    dirs
}

fn find_library(name: &str, dirs: &[PathBuf]) -> Library {
    let development = format!("lib{name}.so");
    for dir in dirs {
        if dir.join(&development).exists() {
            return Library::Found;
        }
    }
    // Pick the newest versioned runtime object that matches the target
    // architecture. Distributions keep 32-bit and 64-bit objects side by
    // side, so the ELF header decides which one may be linked.
    let mut candidates: Vec<(usize, Vec<u64>, PathBuf)> = Vec::new();
    for (index, dir) in dirs.iter().enumerate() {
        let Ok(entries) = std::fs::read_dir(dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let file_name = entry.file_name();
            let Some(file_name) = file_name.to_str() else {
                continue;
            };
            if !file_name.starts_with(&development) || file_name == development {
                continue;
            }
            let Some(suffix) = file_name.strip_prefix(&development) else {
                continue;
            };
            // Only plain version suffixes such as ".so.1" or ".so.0.13.1".
            if suffix.is_empty() || !suffix[1..].chars().all(|c| c.is_ascii_digit() || c == '.') {
                continue;
            }
            let path = entry.path();
            if path.is_file() && matches_target_architecture(&path) {
                candidates.push((index, version_key(&path), path));
            }
        }
    }
    candidates.sort_by(|left, right| {
        left.0
            .cmp(&right.0)
            .then_with(|| left.1.cmp(&right.1))
            .then_with(|| left.2.cmp(&right.2))
    });
    match candidates.pop() {
        Some((_, _, path)) => Library::Versioned(path),
        None => Library::Missing,
    }
}

/// Sort key for versioned library names, so ".so.10" wins over ".so.9".
fn version_key(path: &Path) -> Vec<u64> {
    let Some(name) = path.file_name().and_then(|name| name.to_str()) else {
        return Vec::new();
    };
    name.split('.')
        .skip_while(|part| *part != "so")
        .skip(1)
        .filter_map(|part| part.parse::<u64>().ok())
        .collect()
}

/// Whether the shared object is a 64-bit object for the build target.
fn matches_target_architecture(path: &Path) -> bool {
    let Ok(header) = std::fs::read(path) else {
        return false;
    };
    if header.len() < 20 || &header[..4] != b"ELF" {
        return false;
    }
    // EI_CLASS: 2 is 64-bit.
    if header[4] != 2 {
        return false;
    }
    // e_machine at offset 18, little endian for the supported targets.
    let machine = u16::from_le_bytes([header[18], header[19]]);
    let expected = match std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() {
        Ok("x86_64") => 62,
        Ok("aarch64") => 183,
        _ => return false,
    };
    machine == expected
}
