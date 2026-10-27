//! Raster presentation only. The pane owns identity, decode, mode and lifetime.
use crate::artifact_image::Raster;
use gpui_kit::{
    AnyElement, App, AvailableSpace, Bounds, Element, ElementId, GlobalElementId,
    InspectorElementId, InteractiveElement, IntoElement, LayoutId, ObjectFit, ParentElement,
    Pixels, Styled, StyledImage, TestSupportExt, Window, div, img, px, size,
};

/// Swift ArtifactViewerLayout's inline image ceiling, without enlarging small images.
/// Measure against the resolved width: a CSS aspect ratio alone leaves the virtual
/// list's first measurement at the unconstrained image height, reserving blank space.
/// Takes the upright pixel size, so a header-sized placeholder and its decoded
/// pixels occupy the same row geometry.
pub(crate) fn inline_frame(width: u32, height: u32) -> gpui_kit::Div {
    let (width, height) = (width as f32, height as f32);
    let ratio = width / height;
    div()
        .relative()
        .flex()
        .flex_col()
        .flex_shrink_0()
        .w_full()
        .max_w(px(width.min(720. * ratio).max(48.)))
        .overflow_hidden()
        .child(InlineSize { width, height })
}

struct InlineSize {
    width: f32,
    height: f32,
}
impl IntoElement for InlineSize {
    type Element = Self;
    fn into_element(self) -> Self {
        self
    }
}
impl Element for InlineSize {
    type RequestLayoutState = ();
    type PrepaintState = ();
    fn id(&self) -> Option<ElementId> {
        None
    }
    fn source_location(&self) -> Option<&'static std::panic::Location<'static>> {
        None
    }
    fn request_layout(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        window: &mut Window,
        _: &mut App,
    ) -> (LayoutId, ()) {
        let (width, height) = (self.width, self.height);
        (
            window.request_measured_layout(Default::default(), move |known, available, _, _| {
                let available =
                    known
                        .width
                        .map(f32::from)
                        .unwrap_or_else(|| match available.width {
                            AvailableSpace::Definite(width) => f32::from(width),
                            _ => width,
                        });
                let scale = 1f32.min(available / width).min(720. / height);
                size(
                    px((width * scale).max(48.).min(available)),
                    px((height * scale).max(48.)),
                )
            }),
            (),
        )
    }
    fn prepaint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        _: &mut Window,
        _: &mut App,
    ) {
    }
    fn paint(
        &mut self,
        _: Option<&GlobalElementId>,
        _: Option<&InspectorElementId>,
        _: Bounds<Pixels>,
        _: &mut (),
        _: &mut (),
        _: &mut Window,
        _: &mut App,
    ) {
    }
}

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
