//! Per-user launcher entry for the packaged Linux app. Nothing is shipped in the
//! zip; the running install writes its own menu entry and icon under the user's
//! XDG data directory, pointing at its current location. Entries the user
//! replaced (without the managed marker) are left alone.
use std::{
    fs, io,
    path::{Path, PathBuf},
};

/// Wayland app_id, desktop file name and icon name, so the shell matches windows.
pub const APP_ID: &str = "com.babariviere.pilot-next";
const MANAGED: &str = "X-Pilot-Next-Managed=true";
const ICON: &[u8] = include_bytes!("../resources/linux/pilot-next-256.png");

/// Best effort, off the UI thread. Failures only skip the menu entry.
pub fn install_in_background() {
    let _ = std::thread::Builder::new()
        .name("desktop-entry".into())
        .spawn(|| {
            let result = std::env::current_exe()
                .and_then(|exe| install(&exe, &data_home().ok_or(io::ErrorKind::NotFound)?));
            if let Err(error) = result {
                eprintln!("Linux menu entry was not updated: {error}");
            }
        });
}

fn data_home() -> Option<PathBuf> {
    std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .or_else(|| {
            let home = PathBuf::from(std::env::var_os("HOME")?);
            home.is_absolute().then(|| home.join(".local/share"))
        })
}

/// `executable` is `<root>/libexec/pilot-desktop`; the entry launches `<root>/bin/pilot-next`.
pub(crate) fn install(executable: &Path, data: &Path) -> io::Result<()> {
    let root = executable
        .parent()
        .filter(|libexec| libexec.file_name().is_some_and(|n| n == "libexec"))
        .and_then(Path::parent)
        .ok_or(io::ErrorKind::InvalidInput)?
        .canonicalize()?;
    let launcher = root.join("bin/pilot-next");
    if !launcher.is_file() {
        return Err(io::ErrorKind::NotFound.into());
    }
    let entry = desktop_entry(&launcher).ok_or(io::ErrorKind::InvalidData)?;
    write_if_changed(
        &data.join(format!("icons/hicolor/256x256/apps/{APP_ID}.png")),
        ICON,
    )?;
    let path = data.join(format!("applications/{APP_ID}.desktop"));
    match fs::read_to_string(&path) {
        Ok(existing) if !existing.lines().any(|line| line == MANAGED) => Ok(()),
        _ => write_if_changed(&path, entry.as_bytes()),
    }
}

pub(crate) fn desktop_entry(launcher: &Path) -> Option<String> {
    let path = launcher.to_str()?;
    if path.chars().any(char::is_control) {
        return None;
    }
    // Desktop Entry spec: quote the argument, backslash-escape " ` $ \ inside it,
    // double % for field codes, then apply the string-level \\ escape.
    let mut quoted = String::from("\"");
    for c in path.chars() {
        match c {
            '"' | '`' | '$' | '\\' => {
                quoted.push('\\');
                quoted.push(c);
            }
            '%' => quoted.push_str("%%"),
            _ => quoted.push(c),
        }
    }
    quoted.push('"');
    let exec = quoted.replace('\\', "\\\\");
    Some(format!(
        "[Desktop Entry]\nType=Application\nName=Pilot Next\nComment=Background coding agents\nExec={exec}\nIcon={APP_ID}\nStartupWMClass={APP_ID}\nTerminal=false\nCategories=Development;\n{MANAGED}\n"
    ))
}

fn write_if_changed(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if fs::read(path).is_ok_and(|existing| existing == bytes) {
        return Ok(());
    }
    let parent = path.parent().ok_or(io::ErrorKind::InvalidInput)?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(".{APP_ID}.{}.tmp", std::process::id()));
    fs::write(&temporary, bytes)?;
    fs::rename(&temporary, path).inspect_err(|_| {
        let _ = fs::remove_file(&temporary);
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exec_quotes_spaces_and_escapes_special_characters() {
        let entry =
            desktop_entry(Path::new("/home/u/.local/opt/Pilot Next/bin/pilot-next")).unwrap();
        assert!(entry.contains("Exec=\"/home/u/.local/opt/Pilot Next/bin/pilot-next\"\n"));
        assert!(entry.contains(&format!("Icon={APP_ID}\n")));
        let entry = desktop_entry(Path::new("/a$b\"c%d\\e/bin/pilot-next")).unwrap();
        assert!(entry.contains("Exec=\"/a\\\\$b\\\\\"c%%d\\\\\\\\e/bin/pilot-next\"\n"));
        assert!(desktop_entry(Path::new("/a\nb/bin/pilot-next")).is_none());
    }

    #[test]
    fn install_writes_entry_and_icon_then_respects_user_replacement() {
        let temp = std::env::temp_dir().join(format!("pilot-desktop-entry-{}", std::process::id()));
        let _ = fs::remove_dir_all(&temp);
        let root = temp.join("renamed install");
        fs::create_dir_all(root.join("bin")).unwrap();
        fs::create_dir_all(root.join("libexec")).unwrap();
        fs::write(root.join("bin/pilot-next"), "#!/bin/sh\n").unwrap();
        let data = temp.join("data");
        install(&root.join("libexec/pilot-desktop"), &data).unwrap();
        let path = data.join(format!("applications/{APP_ID}.desktop"));
        let written = fs::read_to_string(&path).unwrap();
        let launcher = root.canonicalize().unwrap().join("bin/pilot-next");
        assert_eq!(written, desktop_entry(&launcher).unwrap());
        assert_eq!(
            fs::read(data.join(format!("icons/hicolor/256x256/apps/{APP_ID}.png"))).unwrap(),
            ICON
        );
        fs::write(&path, "[Desktop Entry]\nName=Mine\n").unwrap();
        install(&root.join("libexec/pilot-desktop"), &data).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "[Desktop Entry]\nName=Mine\n"
        );
        assert!(install(&temp.join("elsewhere/pilot-desktop"), &data).is_err());
        fs::remove_dir_all(&temp).unwrap();
    }
}
