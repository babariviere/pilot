use super::*;

fn temp(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir()
        .canonicalize()
        .unwrap()
        .join(format!("pilot-job-log-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    dir.join(name)
}

#[test]
fn cleans_terminal_output_into_lines() {
    assert_eq!(
        lines(
            "\u{1b}[1;32mok\u{1b}[0m done\r\nstep 1/3\rstep 3/3\n\u{1b}]0;title\u{7}tab\there\u{8}\n日本 👩‍💻"
        ),
        ["ok done", "step 3/3", "tab    here", "日本 👩‍💻"]
    );
    assert_eq!(lines("one\n"), ["one"]);
    assert!(lines("").is_empty());
}

#[test]
fn follows_appends_and_survives_truncation() {
    let path = temp("job.log");
    assert_eq!(read(&path, 0, WINDOW), Err("No log file yet."));
    std::fs::write(&path, "first\nsec").unwrap();
    let mut tail = Tail::default();
    assert!(tail.apply(read(&path, tail.offset, WINDOW).unwrap()));
    assert_eq!(*tail.lines, ["first", "sec"]);
    assert!(
        !tail.apply(read(&path, tail.offset, WINDOW).unwrap()),
        "no change, no update"
    );
    use std::io::Write;
    std::fs::OpenOptions::new()
        .append(true)
        .open(&path)
        .unwrap()
        .write_all("ond 日本\nthird\n".as_bytes())
        .unwrap();
    assert!(tail.apply(read(&path, tail.offset, WINDOW).unwrap()));
    assert_eq!(*tail.lines, ["first", "second 日本", "third"]);
    assert!(!tail.clipped);
    std::fs::write(&path, "new\n").unwrap();
    assert!(tail.apply(read(&path, tail.offset, WINDOW).unwrap()));
    assert_eq!(*tail.lines, ["new"]);
    assert!(
        tail.clipped,
        "a replaced file says older output isn't shown"
    );
    assert_eq!(
        read(path.parent().unwrap(), 0, WINDOW).unwrap_err(),
        "The log path isn't a regular file."
    );
    assert!(read(std::path::Path::new("relative.log"), 0, WINDOW).is_err());
}

#[test]
fn keeps_only_the_newest_window_from_a_whole_line() {
    let path = temp("big.log");
    let text: String = (0..20_000).map(|n| format!("line {n} 日本語\n")).collect();
    std::fs::write(&path, &text).unwrap();
    let mut tail = Tail::default();
    let chunk = read(&path, 0, WINDOW).unwrap();
    assert!(chunk.start > 0 && chunk.bytes.len() == WINDOW);
    tail.apply(chunk);
    assert!(tail.clipped);
    assert!(
        tail.lines.first().unwrap().starts_with("line "),
        "starts at a whole line"
    );
    assert_eq!(tail.lines.last().unwrap(), "line 19999 日本語");
    assert!(tail.lines.iter().all(|l| !l.contains('\u{fffd}')));
    assert!(tail.text().len() <= WINDOW);
}
