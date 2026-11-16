//! Real NSH picker and Day image controls. Hidden, offline, not native appearance or IME acceptance.
use base64::{Engine, engine::general_purpose::STANDARD};
use nsh_core::{ImageData, picker::PickedFile};
use nsh_engine::EngineConfig;
use nsh_testing::{Headless, compile_tsx};
use std::path::PathBuf;

struct Scratch(PathBuf);
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn picker_cancel_keeps_words_and_a_picked_screenshot_can_retry_or_be_removed() {
    // Like connected.rs, copy app sources/assets into a private test root.
    // Only this root declares picker access; the default app stays deny-all.
    let scratch =
        Scratch(std::env::temp_dir().join(format!("feedback-picker-{}", uuid::Uuid::new_v4())));
    let dir = &scratch.0;
    let source = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap()
        .to_path_buf();
    std::fs::create_dir(dir).unwrap();
    for entry in std::fs::read_dir(&source).unwrap() {
        let path = entry.unwrap().path();
        if path.is_file()
            && matches!(
                path.extension().and_then(|s| s.to_str()),
                Some("ts" | "tsx" | "json")
            )
        {
            std::fs::copy(&path, dir.join(path.file_name().unwrap())).unwrap();
        }
    }
    // The component library lives in ui/; screens import it as "./ui".
    std::fs::create_dir(dir.join("ui")).unwrap();
    for file in std::fs::read_dir(source.join("ui")).unwrap() {
        let path = file.unwrap().path();
        std::fs::copy(&path, dir.join("ui").join(path.file_name().unwrap())).unwrap();
    }
    std::fs::create_dir(dir.join("icons")).unwrap();
    for icon in std::fs::read_dir(source.join("icons")).unwrap() {
        let path = icon.unwrap().path();
        std::fs::copy(&path, dir.join("icons").join(path.file_name().unwrap())).unwrap();
    }
    std::fs::write(dir.join("nsh.json"), r#"{"name":"Picker fixture","id":"test.feedback.picker","theme":"theme.json","capabilities":{"picker":true}}"#).unwrap();
    let entry = dir.join("PickerFixture.tsx");
    std::fs::write(&entry, r#"
import { mount, Text, View } from 'nsh';
import { Input } from 'nsh/base';
import { FeedbackImages } from './FeedbackImages';
import { feedbackDraft } from './feedbackView';
feedbackDraft.set({text:'Keep my draft',origin:null});
mount(() => <View><FeedbackImages disabled={false}>{onPaste => <Input testID="words" value={feedbackDraft().text} onChange={({value}) => feedbackDraft.update(d => ({...d,text:value}))} onPaste={onPaste}/>}</FeedbackImages><Text>{feedbackDraft().text}</Text></View>);
"#).unwrap();
    let sets = vec![nsh_base::registry(), pilot_day_native::registry()];
    let bundle = compile_tsx(entry, &sets).unwrap();
    let mut config = EngineConfig::new(bundle);
    config.ui_sets = sets;
    let mut app = Headless::start(config).unwrap();
    app.wait_for("id:feedback-image-add").unwrap();
    app.on_pick(|_| vec![]);
    app.press("id:feedback-image-add").unwrap();
    assert!(app.screen().shows("Keep my draft"));
    assert!(!app.screen().shows("id:feedback-image-retry"));
    let png = STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAEElEQVR4AQEFAPr/AP8AAP8FAAH/+lyI0QAAAABJRU5ErkJggg==").unwrap();
    app.on_pick(move |_| {
        vec![PickedFile::new(
            "screen.png",
            "image/png",
            ImageData::new(png.clone()),
        )]
    });
    app.press("id:feedback-image-add").unwrap();
    app.wait_for("id:feedback-image-retry").unwrap();
    assert_eq!(app.picks().len(), 2);
    assert!(app.screen().shows("Keep my draft"));
    app.press("id:feedback-image-retry").unwrap();
    assert!(app.screen().shows("Image not attached"));
    app.press("Remove image").unwrap();
    assert!(!app.screen().shows("id:feedback-image-retry"));
    assert!(app.screen().shows("Keep my draft"));
}
