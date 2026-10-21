use super::*;
use gpui_kit::{
    Bounds, ScrollDelta, TestAppContext, WindowBounds, WindowOptions, base::TextSelection, point,
    px, size, test::TestWindowExt,
};

pub(super) fn setup(
    cx: &mut TestAppContext,
    rows: Vec<Message>,
) -> (gpui_kit::AnyWindowHandle, Entity<TranscriptView>) {
    cx.update(|cx| {
        gpui_kit::init(cx);
        TranscriptView::bind_keys(cx);
    });
    let result = cx.update(|cx| {
        gpui_kit::open_window(
            WindowOptions {
                window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                    Default::default(),
                    size(px(960.), px(760.)),
                ))),
                show: false,
                ..Default::default()
            },
            cx,
            |window, cx| {
                cx.new(|cx| {
                    let mut view = TranscriptView::readonly(window, cx);
                    view.replace_readonly(rows, true, cx);
                    view
                })
            },
        )
        .unwrap()
    });
    cx.run_until_parked();
    result
}

#[gpui_kit::test]
fn readonly_projection_keeps_selected_entity_across_prepend_delta_and_commit(
    cx: &mut TestAppContext,
) {
    let rows: Vec<_> = (20..68)
        .map(|id| Message::live(id, "assistant".into(), crate::model::REPLY.into()))
        .collect();
    let (handle, view) = setup(cx, rows.clone());
    let (selected, range, copied, query) = cx
        .update_window(handle, |_, window, cx| {
            window.render_frame(cx);
            let text = view
                .read(cx)
                .text_states
                .last()
                .unwrap()
                .as_ref()
                .unwrap()
                .clone();
            let start = text.read(cx).bounds().origin + point(px(3.), px(10.));
            window.drag(start, start + point(px(80.), px(0.)), cx);
            let range = text.read(cx).selected_source_range().unwrap();
            let query = TextSelection::selected_text(window, cx);
            window.press("secondary-c", cx);
            let copied = cx.read_from_clipboard().unwrap().text().unwrap();
            assert!(!copied.is_empty());
            window.scroll(
                "viewport",
                ScrollDelta::Pixels(point(px(0.), px(10000.))),
                cx,
            );
            (text, range, copied, query)
        })
        .unwrap();
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        let before = view.read(cx).scroller.read(cx).logical_scroll_top();
        let anchor = view.read(cx).transcript.messages()[before.item_ix].id();
        let mut next: Vec<_> = (8..20)
            .map(|id| Message::live(id, "assistant".into(), crate::model::REPLY.into()))
            .collect();
        next.extend(rows.clone());
        if let Some(row) = next.last_mut() {
            *row = Message::live(
                row.id(),
                "assistant · committed".into(),
                format!("{}\n\nMore streamed words.", row.source()),
            )
        }
        view.update(cx, |view, cx| view.replace_readonly(next, false, cx));
        window.render_frame(cx);
        assert_eq!(
            view.read(cx).text_states.last().unwrap().as_ref().unwrap(),
            &selected
        );
        assert_eq!(
            selected.read(cx).selected_source_range(),
            Some(range.clone())
        );
        assert!(!view.read(cx).scroller.read(cx).is_following_tail());
        let after = view.read(cx).scroller.read(cx).logical_scroll_top();
        assert_eq!(
            view.read(cx).transcript.messages()[after.item_ix].id(),
            anchor
        );
        window.press("secondary-c", cx);
        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), copied);
        window.scroll(
            "viewport",
            ScrollDelta::Pixels(point(px(0.), px(-10000.))),
            cx,
        );
        window.render_frame(cx);
        assert_eq!(TextSelection::selected_text(window, cx), query);
        window.press("secondary-c", cx);
        assert_eq!(cx.read_from_clipboard().unwrap().text().unwrap(), copied);
        // A different chat with reused entry numbers must never inherit selection or its entities.
        view.update(cx, |view, cx| view.replace_readonly(rows, true, cx));
        assert_ne!(
            view.read(cx).text_states.last().unwrap().as_ref().unwrap(),
            &selected
        );
        assert!(
            view.read(cx)
                .text_states
                .last()
                .unwrap()
                .as_ref()
                .unwrap()
                .read(cx)
                .selected_source_range()
                .is_none()
        );
    })
    .unwrap();
}

#[gpui_kit::test]
fn readonly_cannot_submit_and_images_never_reach_the_http_client(cx: &mut TestAppContext) {
    use std::sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
    };
    let requests = Arc::new(AtomicUsize::new(0));
    let seen = requests.clone();
    cx.update(|cx| {
        cx.set_http_client(gpui_kit::http_client::FakeHttpClient::create(move |_| {
            seen.fetch_add(1, Ordering::SeqCst);
            async {
                Ok(gpui_kit::http_client::Response::builder()
                    .status(404)
                    .body(Default::default())
                    .unwrap())
            }
        }))
    });
    let (handle,view)=setup(cx,vec![Message::live(1,"assistant".into(),"![blocked](https://example.invalid/pixel.png)\n\n[blocked link](https://example.invalid)".into())]);
    cx.update_window(handle, |_, window, cx| {
        window.render_frame(cx);
        view.update(cx, |view, cx| {
            view.composer.update(cx, |state, cx| {
                state.set_value("must not submit", window, cx)
            });
            view.submit(window, cx);
            view.demo(cx);
            view.prepend(cx);
            assert_eq!(view.transcript.messages().len(), 1);
            assert!(!view.transcript.is_streaming());
        });
        window.press("secondary-l", cx);
        window.press("enter", cx);
        window.click(("copy-source", 1_u64), cx);
        assert!(
            cx.read_from_clipboard()
                .unwrap()
                .text()
                .unwrap()
                .starts_with("![blocked]")
        );
    })
    .unwrap();
    cx.run_until_parked();
    cx.update_window(handle, |_, window, cx| window.render_frame(cx))
        .unwrap();
    assert_eq!(requests.load(Ordering::SeqCst), 0);
}
