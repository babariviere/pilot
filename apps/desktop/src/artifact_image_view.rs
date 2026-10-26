//! Raster presentation only. The pane owns identity, decode, mode and lifetime.
use crate::artifact_image::Raster;
use gpui_kit::{
    AnyElement, InteractiveElement, IntoElement, ObjectFit, ParentElement,
    StatefulInteractiveElement, Styled, StyledImage, TestSupportExt, Window, div, img, px,
};

pub(crate) fn preview(raster: &Raster, actual: bool, window: &Window) -> AnyElement {
    let image = img(raster.image.clone())
        .object_fit(ObjectFit::Contain)
        .id("artifact-raster-pixels")
        .test_support();
    let viewport = div()
        .id("artifact-raster-viewport")
        .test_support()
        .absolute()
        .inset_0()
        .min_w_0()
        .min_h_0();
    if actual {
        // Content pixels, not chrome spacing: one stored pixel per device pixel,
        // independently of rem/application zoom. This viewport owns both axes.
        viewport
            .overflow_scroll()
            .child(
                image
                    .flex_shrink_0()
                    .w(px(raster.width as f32 / window.scale_factor()))
                    .h(px(raster.height as f32 / window.scale_factor())),
            )
            .into_any_element()
    } else {
        viewport
            .overflow_hidden()
            // Keep the layout box pinned to the viewport. Img supplies an
            // intrinsic aspect ratio during layout; normal-flow percentage
            // height can otherwise grow past a short, wide viewport. Contain
            // still preserves the original raster's aspect ratio when painting.
            .child(image.absolute().inset_0().size_full().min_w_0().min_h_0())
            .into_any_element()
    }
}
