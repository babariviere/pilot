//! Explicit sidebar disclosures only. Logical rows change immediately; an exit
//! retains empty space, not old rows or their keyboard/pointer targets.
use crate::transition::{Transition, ease_out};
use gpui_kit::{App, Pixels, Size, Window};
use std::{
    collections::{HashMap, HashSet},
    time::{Duration, Instant},
};

#[derive(Default)]
pub(super) struct Motion {
    key: String,
    rows: HashSet<String>,
    anchor: String,
    heights: Vec<(String, f32)>,
    displayed: HashMap<String, f32>,
    from: f32,
    shown: f32,
    target: f32,
    pending: bool,
    sampled_at: Option<Instant>,
    transition: Transition,
    viewport: Option<(Size<Pixels>, Pixels, f32)>,
}
impl Motion {
    pub(super) fn cancel(&mut self) {
        let viewport = self.viewport;
        *self = Self {
            viewport,
            ..Self::default()
        };
    }
    pub(super) fn arm(&mut self, key: String, before: &[(String, f32)], after: &[(String, f32)]) {
        if self.viewport.is_none() {
            return;
        }
        let old: HashSet<_> = before.iter().map(|(id, _)| id.as_str()).collect();
        let new: HashSet<_> = after.iter().map(|(id, _)| id.as_str()).collect();
        let changed: HashSet<String> = old
            .symmetric_difference(&new)
            .map(|id| (*id).to_owned())
            .collect();
        if changed.is_empty() {
            return;
        }
        if self.key != key || self.rows.is_empty() {
            self.cancel();
            self.shown = before
                .iter()
                .filter(|(id, _)| changed.contains(id))
                .map(|(_, h)| h)
                .sum();
            self.rows = changed;
        } else {
            self.rows.extend(changed);
        }
        self.key = key;
        // The last surviving row before the changed run owns any empty exit space.
        let expanded = if before.len() > after.len() {
            before
        } else {
            after
        };
        self.anchor = expanded
            .iter()
            .take_while(|(id, _)| !self.rows.contains(id))
            .filter(|(id, _)| new.contains(id.as_str()))
            .last()
            .map(|(id, _)| id.clone())
            .unwrap_or_default();
        self.heights = after
            .iter()
            .filter(|(id, _)| self.rows.contains(id))
            .cloned()
            .collect();
        self.target = self.heights.iter().map(|(_, h)| h).sum();
        self.from = self.shown;
        self.pending = true;
    }
    pub(super) fn sample(&mut self, width: f32, w: &mut Window, cx: &App) -> bool {
        let viewport = (w.viewport_size(), w.rem_size(), width);
        let resized = self.viewport.is_some_and(|old| old != viewport);
        self.viewport = Some(viewport);
        if self.rows.is_empty() {
            return false;
        }
        if resized || cx.reduce_motion() {
            self.cancel();
            self.viewport = Some(viewport);
            return true;
        }
        let now = cx.background_executor().now();
        if !self.pending && self.sampled_at == Some(now) {
            return false;
        }
        self.sampled_at = Some(now);
        if self.pending {
            self.transition.start(cx);
            self.pending = false;
        }
        let t = ease_out(self.transition.progress(Duration::from_millis(200), w, cx));
        self.shown = self.from + (self.target - self.from) * t;
        self.displayed.clear();
        self.displayed
            .insert(self.anchor.clone(), (self.shown - self.target).max(0.));
        let mut offset = 0.;
        for (id, height) in &self.heights {
            self.displayed
                .insert(id.clone(), (self.shown - offset).clamp(0., *height));
            offset += height;
        }
        if t == 1. {
            self.cancel();
            self.viewport = Some(viewport);
        }
        true
    }
    pub(super) fn active(&self) -> bool {
        !self.rows.is_empty()
    }
    pub(super) fn height(&self, key: &str, natural: f32) -> f32 {
        if self.rows.is_empty() {
            return natural;
        }
        if key == self.anchor {
            return natural + self.displayed.get(key).copied().unwrap_or(0.);
        }
        self.displayed.get(key).copied().unwrap_or(natural)
    }
}
