//! Export uses the released system-dialog seam and a real temporary destination.
use nsh_engine::EngineConfig;
use nsh_testing::{Headless, compile_tsx};
use serde_json::json;

#[test]
fn displayed_bytes_export_only_after_the_save_dialog_and_cancel_writes_nothing() {
    let dir = std::env::temp_dir().join(format!("artifact-export-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir(&dir).unwrap();
    struct Temp(std::path::PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    let _temp = Temp(dir.clone());
    let source = "<script>never execute</script>\r\né😀";
    let snapshot = json!({"version":1,"reference":{"revision":7},"metadata":{"title":"Saved report","kind":"html"},
        "rendering":"unsupported","content":{"state":"text","source":source,"containerSha256":"a".repeat(64),"containerBytes":100}});
    let entry = dir.join("Export.tsx");
    std::fs::write(&entry, format!(r#"
import {{mount,signal,Text,View}} from 'nsh';
import {{Button}} from 'nsh/base';
import {{ArtifactExport}} from 'pilot-day/native';
const snapshot = {};
mount(() => {{
  const result = signal('Waiting');
  const exporter = new ArtifactExport();
  return <View><Text>{{result()}}</Text><Button onPress={{() => exporter.save(JSON.stringify(snapshot)).then(result.set)}}><Text>Export</Text></Button></View>;
}});
"#, snapshot)).unwrap();
    let sets = vec![nsh_base::registry(), pilot_day_native::registry()];
    let bundle = compile_tsx(&entry, &sets).unwrap();
    let mut config = EngineConfig::new(bundle);
    config.ui_sets = sets;
    let mut app = Headless::start(config).unwrap();
    app.wait_for("Waiting").unwrap();
    let destination = dir.join("chosen.txt");
    app.on_pick_save_path(None).unwrap();
    assert!(!destination.exists());
    assert!(app.screen().file_requests().is_empty());
    app.press("Export").unwrap();
    app.wait_for("Export canceled.").unwrap();
    assert!(!destination.exists());
    app.on_pick_save_path(Some(destination.clone())).unwrap();
    app.press("Export").unwrap();
    app.wait_for("Exported Saved_report-v7.txt.").unwrap();
    assert_eq!(std::fs::read(&destination).unwrap(), source.as_bytes());
    let requests = app.screen().file_requests();
    assert!(requests.iter().all(|r| matches!(r, nsh_core::file_dialog::FileRequest::SaveDialog(d) if d.file_name.as_deref() == Some("Saved_report-v7.txt"))));
    assert_eq!(
        std::fs::read_dir(&dir).unwrap().count(),
        2,
        "no leftover temporary exports"
    );
}
