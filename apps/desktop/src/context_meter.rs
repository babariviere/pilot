//! Native adaptation of MonoCode's ContextMeter.tsx (MeterRing) and
//! model/contextUsage.ts (contextRatio), under src/features/sessions/ at
//! 26465c620977f3951d0a532a0f7db32c3c179007. Copyright (c) 2026 Nick.
//! MIT notice: ../licenses/MONOCODE.txt. No empty-history fallback, thresholds,
//! partial-report merge, compaction action, or progress transition is adopted.
use crate::context_usage::Usage;
use gpui_kit::{
    App, InteractiveElement, IntoElement, ParentElement, PathBuilder, Styled, TestSupportExt,
    canvas, component::ActiveTheme, div, point, px,
};

#[derive(Debug, PartialEq)]
pub(crate) struct Meter {
    pub(crate) ratio: f32,
    pub(crate) description: String,
}
impl Meter {
    pub(crate) fn reported(usage: &Usage) -> Option<Self> {
        let (used, limit) = usage.context_pair()?;
        let ratio = used as f64 / limit as f64;
        Some(Self {
            ratio: ratio.clamp(0., 1.) as f32,
            description: format!(
                "{}. Freshness unknown.{} Open Context details.",
                usage.context_line(),
                if used > limit {
                    " Report exceeds the reported window; gauge capped at 100%."
                } else {
                    ""
                }
            ),
        })
    }
    /// Fixed native geometry, neutral semantic ink, no clock or transition.
    pub(crate) fn ring(&self, cx: &App) -> impl IntoElement {
        let ratio = self.ratio;
        let ink = cx.theme().muted_foreground;
        let mut track = ink;
        track.a *= 0.25;
        div()
            .id("context-meter-ring")
            .test_support()
            .size(px(14.))
            .flex_none()
            .child(
                canvas(
                    |_, _, _| (),
                    move |bounds, (), window, _| {
                        // At most 128 line segments across both paths. Skip the
                        // used arc at zero, rather than drawing a misleading dot.
                        for (fraction, color) in [(1., track), (ratio, ink)] {
                            if fraction <= 0. {
                                continue;
                            }
                            let mut path = PathBuilder::stroke(px(2.));
                            let center = bounds.center();
                            let segments = (64. * fraction).ceil() as usize;
                            for i in 0..=segments {
                                let angle = -std::f32::consts::FRAC_PI_2
                                    + std::f32::consts::TAU * fraction * i as f32 / segments as f32;
                                let p = center + point(px(angle.cos() * 6.), px(angle.sin() * 6.));
                                if i == 0 {
                                    path.move_to(p);
                                } else {
                                    path.line_to(p);
                                }
                            }
                            if let Ok(path) = path.build() {
                                window.paint_path(path, color);
                            }
                        }
                    },
                )
                .size_full(),
            )
    }
}

#[cfg(test)]
#[path = "context_meter_tests.rs"]
mod tests;
