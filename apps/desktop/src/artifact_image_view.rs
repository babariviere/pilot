//! Raster presentation only. The pane owns identity, decode, mode and lifetime.
use crate::artifact_image::Raster;
use gpui_kit::{
    AnyElement, InteractiveElement, IntoElement, ObjectFit, ParentElement, Styled, StyledImage,
    TestSupportExt, Window, div, img, px,
};

pub(crate) fn preview(raster: &Raster) -> AnyElement {
    div()
        .id("artifact-raster-viewport")
        .test_support()
        .absolute()
        .inset_0()
        .min_w_0()
        .min_h_0()
        .overflow_hidden()
        .child(
            img(raster.image.clone())
                .object_fit(ObjectFit::Contain)
                .id("artifact-raster-pixels")
                .test_support()
                .absolute()
                .inset_0()
                .size_full()
                .min_w_0()
                .min_h_0(),
        )
        .into_any_element()
}

pub(crate) fn zoomed<T: 'static>(
    raster: &Raster,
    zoom: &crate::reader_zoom::Zoom,
    window: &Window,
    cx: &gpui_kit::Context<T>,
) -> AnyElement {
    let width = raster.width as f32 / window.scale_factor();
    let height = raster.height as f32 / window.scale_factor();
    let content = if let Some(scale) = zoom.scale {
        div()
            .flex_shrink_0()
            .w(px(width * scale))
            .h(px(height * scale))
            .child(
                img(raster.image.clone())
                    .object_fit(ObjectFit::Contain)
                    .id("artifact-raster-pixels")
                    .test_support()
                    .size_full(),
            )
            .into_any_element()
    } else {
        div()
            .relative()
            .size_full()
            .child(
                img(raster.image.clone())
                    .object_fit(ObjectFit::Contain)
                    .id("artifact-raster-pixels")
                    .test_support()
                    .absolute()
                    .inset_0()
                    .size_full()
                    .min_w_0()
                    .min_h_0(),
            )
            .into_any_element()
    };
    zoom.surface(content, cx)
}
