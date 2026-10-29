//! Bounded brief values and immutable save capture. No I/O or inferred write ACK.
#[cfg(test)]
#[path = "mission_brief_tests.rs"]
mod tests;
use crate::{local_model::valid_id, mission_browser::Key};
use serde_json::Value;
use std::{collections::BTreeSet, sync::Arc};

pub(crate) const WIRE_BYTES: usize = 2 * 1024 * 1024;
pub(crate) const SOURCE_BYTES: usize = 1024 * 1024;
pub(crate) const EDIT_BYTES: usize = 64 * 1024;
pub(crate) const DISPLAY_BYTES: usize = 32 * 1024;
pub(crate) const HISTORY_BYTES: usize = 128 * 1024;
pub(crate) const HISTORY_COUNT: usize = 256;
pub(crate) const DRAFT_COUNT: usize = 16;
pub(crate) const MAX_REVISION: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Source {
    pub(crate) key: Key,
    pub(crate) project: String,
}
impl Source {
    pub(crate) fn valid(&self) -> bool {
        self.key.valid() && valid_id(&self.project)
    }
    pub(crate) fn canonical(&self, catalog: &crate::mission_browser::Catalog) -> bool {
        self.valid()
            && catalog.rows.iter().any(|r| {
                r.key == self.key
                    && r.sources.iter().any(|p| {
                        p.canonical && p.home == self.key.home && p.project == self.project
                    })
            })
    }
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Revision {
    pub(crate) number: u64,
    pub(crate) author: Option<String>,
    pub(crate) created: f64,
}
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Brief {
    pub(crate) source: Source,
    pub(crate) revision: Revision,
    pub(crate) markdown: Arc<str>,
}
impl Brief {
    pub(crate) fn visible(&self) -> &str {
        &self.markdown[..self
            .markdown
            .floor_char_boundary(self.markdown.len().min(DISPLAY_BYTES))]
    }
    pub(crate) fn clipped(&self) -> bool {
        self.markdown.len() > DISPLAY_BYTES
    }
    pub(crate) fn editable(&self) -> bool {
        self.markdown.len() <= EDIT_BYTES
    }
}
fn revision(v: &Value) -> Result<Revision, &'static str> {
    let number = v["revision"]
        .as_u64()
        .filter(|n| *n > 0 && *n <= MAX_REVISION)
        .ok_or("Invalid brief revision.")?;
    let created = v["createdAt"]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.)
        .ok_or("Invalid brief revision time.")?;
    let author = if v["authorSessionId"].is_null() {
        None
    } else {
        Some(
            v["authorSessionId"]
                .as_str()
                .filter(|id| valid_id(id))
                .ok_or("Invalid brief author identity.")?
                .into(),
        )
    };
    Ok(Revision {
        number,
        author,
        created,
    })
}
pub(crate) fn parse(
    source: &Source,
    v: &Value,
    requested: Option<u64>,
) -> Result<Brief, &'static str> {
    if !source.valid() || v["missionId"].as_str() != Some(source.key.id.as_str()) {
        return Err("Brief belongs to another canonical mission.");
    }
    let revision = revision(v)?;
    if requested.is_some_and(|n| n != revision.number) {
        return Err("Brief belongs to another immutable revision.");
    }
    let markdown = v["markdown"].as_str().ok_or("Brief source is invalid.")?;
    Ok(Brief {
        source: source.clone(),
        revision,
        markdown: markdown.into(),
    })
}
pub(crate) fn history(v: &Value) -> Result<Vec<Revision>, &'static str> {
    let raw = v
        .as_array()
        .filter(|a| a.len() <= HISTORY_COUNT)
        .ok_or("Brief history is unavailable or exceeds the 256-revision limit.")?;
    let mut seen = BTreeSet::new();
    let mut result = Vec::with_capacity(raw.len());
    for item in raw {
        let r = revision(item)?;
        if !seen.insert(r.number) {
            return Err("Duplicate brief revision identity.");
        }
        result.push(r);
    }
    result.sort_by_key(|r| std::cmp::Reverse(r.number));
    Ok(result)
}

/// Client-only capture identity, not a daemon idempotency key or replay grant.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Save {
    pub(crate) id: String,
    pub(crate) source: Source,
    pub(crate) expected: u64,
    pub(crate) base: Arc<str>,
    pub(crate) markdown: Arc<str>,
}
impl Save {
    pub(crate) fn capture(
        source: Source,
        expected: u64,
        base: &str,
        text: &str,
    ) -> Result<Self, &'static str> {
        if !source.valid() || expected >= MAX_REVISION {
            return Err("Brief source or base revision is invalid.");
        }
        if base.len() > EDIT_BYTES || (expected == 0 && !base.is_empty()) || text.len() > EDIT_BYTES
        {
            return Err(
                "Draft exceeds the 64 KiB native edit limit. Copy the full draft; nothing was saved.",
            );
        }
        Ok(Self {
            id: uuid::Uuid::new_v4().to_string(),
            source,
            expected,
            base: base.into(),
            markdown: text.into(),
        })
    }
    pub(crate) fn acknowledges(&self, brief: &Brief) -> bool {
        let normalized = crate::mission_conversion::trim_text(&self.markdown);
        let revision = if self.expected > 0 && normalized == self.base.as_ref() {
            self.expected
        } else {
            self.expected + 1
        };
        brief.source == self.source
            && brief.revision.number == revision
            && brief.markdown.as_ref() == normalized
    }
}

pub(crate) fn header(source: &Source, value: &Value) -> Result<u64, &'static str> {
    let m = &value["mission"];
    if m["id"].as_str() != Some(source.key.id.as_str())
        || m["projectId"].as_str() != Some(source.project.as_str())
    {
        return Err("Mission brief header belongs to another source.");
    }
    m["briefRevision"]
        .as_u64()
        .filter(|n| *n <= MAX_REVISION)
        .ok_or("Mission brief header revision is invalid.")
}
#[derive(Clone, Debug)]
pub(crate) struct Current {
    pub(crate) source: Source,
    pub(crate) brief: Option<Arc<Brief>>,
}
impl Current {
    pub(crate) fn number(&self) -> u64 {
        self.brief.as_ref().map_or(0, |b| b.revision.number)
    }
    pub(crate) fn text(&self) -> &str {
        self.brief.as_ref().map_or("", |b| b.markdown.as_ref())
    }
}
#[derive(Clone, Debug)]
pub(crate) struct Draft {
    pub(crate) base: u64,
    pub(crate) original: Arc<str>,
    pub(crate) text: Arc<str>,
    pub(crate) serial: u64,
    reviewed: bool,
}
impl Draft {
    pub(crate) fn reviewed(&self) -> bool {
        self.reviewed
    }
    pub(crate) fn dirty(&self) -> bool {
        self.text != self.original
    }
}
#[derive(Clone, Debug)]
pub(crate) enum Outcome {
    Pending,
    Confirmed(Arc<Brief>),
    Conflict,
    Rejected(&'static str),
    Unknown(&'static str),
}
#[derive(Clone, Debug)]
pub(crate) struct Attempt {
    pub(crate) save: Save,
    pub(crate) serial: u64,
    pub(crate) outcome: Outcome,
}
#[derive(Debug)]
pub(crate) struct Entry {
    pub(crate) source: Source,
    pub(crate) current: Option<Current>,
    pub(crate) draft: Option<Draft>,
    pub(crate) attempt: Option<Attempt>,
    /// Complete validated mutation acknowledgment, independent of read failures.
    pub(crate) known: Option<Attempt>,
    /// Explicit recovery never relabels an earlier unconfirmed operation.
    pub(crate) unconfirmed: Vec<Attempt>,
}
impl Entry {
    pub(crate) fn pending(&self) -> bool {
        self.attempt
            .as_ref()
            .is_some_and(|a| matches!(a.outcome, Outcome::Pending))
    }
    pub(crate) fn receive(&mut self, current: Current) {
        if current.source == self.source
            && self
                .current
                .as_ref()
                .is_none_or(|old| current.number() >= old.number())
        {
            self.current = Some(current);
        }
    }
    pub(crate) fn edit(&mut self) -> Result<(), &'static str> {
        if let Some(d) = &mut self.draft {
            d.serial = d
                .serial
                .checked_add(1)
                .ok_or("Draft edit counter is exhausted.")?;
            return Ok(());
        }
        let current = self
            .current
            .as_ref()
            .ok_or("Read the current brief before editing.")?;
        if current.text().len() > EDIT_BYTES {
            return Err(
                "This brief exceeds the 64 KiB native edit limit. Full received text can still be copied.",
            );
        }
        self.draft = Some(Draft {
            base: current.number(),
            original: current.text().into(),
            text: current.text().into(),
            serial: 0,
            reviewed: true,
        });
        Ok(())
    }
    pub(crate) fn confirmed_current_edit(&self) -> bool {
        self.attempt
            .as_ref()
            .zip(self.draft.as_ref())
            .is_some_and(|(a, d)| {
                matches!(a.outcome, Outcome::Confirmed(_)) && a.serial == d.serial
            })
    }
    pub(crate) fn change(&mut self, text: &str) -> Result<(), &'static str> {
        if text.len() > SOURCE_BYTES {
            return Err(
                "Draft exceeds the retained source limit. Copy the current input before leaving this editor.",
            );
        }
        let d = self.draft.as_mut().ok_or("No brief draft is open.")?;
        if d.text.as_ref() == text {
            return if text.len() > EDIT_BYTES {
                Err(
                    "Draft exceeds the native edit byte limit. The text is retained; Save is unavailable.",
                )
            } else {
                Ok(())
            };
        }
        let serial = d
            .serial
            .checked_add(1)
            .ok_or("Draft edit counter is exhausted.")?;
        d.serial = serial;
        d.text = text.into();
        if text.len() > EDIT_BYTES {
            return Err(
                "Draft exceeds the native edit byte limit. The text is retained; Save is unavailable.",
            );
        }
        Ok(())
    }
    pub(crate) fn use_latest(&mut self) -> Result<(), &'static str> {
        if self.pending() {
            return Err("Wait for the captured save result before choosing a new base.");
        }
        let current = self
            .current
            .as_ref()
            .ok_or("Read the latest brief before choosing a new base.")?;
        if current.text().len() > EDIT_BYTES {
            return Err(
                "Latest brief exceeds the native edit limit. Copy your draft and the full received text.",
            );
        }
        let d = self.draft.as_mut().ok_or("No brief draft is open.")?;
        d.base = current.number();
        d.original = current.text().into();
        d.reviewed = true;
        // Keep the user's full text, including edits made during a prior save.
        Ok(())
    }
    pub(crate) fn discard(&mut self) -> Result<(), &'static str> {
        if self.pending() {
            return Err("A captured save is still pending. Its draft cannot be discarded.");
        }
        self.draft = None;
        Ok(())
    }
    fn begin(&mut self) -> Result<Save, &'static str> {
        if self.pending() {
            return Err("A brief save is already pending.");
        }
        let d = self.draft.as_ref().ok_or("Edit the brief before saving.")?;
        if !d.reviewed {
            return Err(
                "Review the latest brief and explicitly choose its base before another Save.",
            );
        }
        if self.current.as_ref().is_some_and(|c| c.number() > d.base) {
            return Err("A newer brief is available. Review it and explicitly choose a new base.");
        }
        if self.unconfirmed.len()
            + usize::from(
                self.attempt
                    .as_ref()
                    .is_some_and(|a| matches!(a.outcome, Outcome::Unknown(_))),
            )
            >= 4
        {
            return Err(
                "Unconfirmed save history is full. Copy your draft; no new save was started.",
            );
        }
        let save = Save::capture(self.source.clone(), d.base, &d.original, &d.text)?;
        if let Some(a) = self.attempt.take()
            && matches!(a.outcome, Outcome::Unknown(_))
        {
            self.unconfirmed.push(a);
        }
        self.attempt = Some(Attempt {
            save: save.clone(),
            serial: d.serial,
            outcome: Outcome::Pending,
        });
        if let Some(d) = &mut self.draft {
            d.reviewed = false;
        }
        Ok(save)
    }
    fn finish(&mut self, save: &Save, outcome: Outcome) -> bool {
        let Some(a) = self
            .attempt
            .as_mut()
            .filter(|a| a.save == *save && matches!(a.outcome, Outcome::Pending))
        else {
            return false;
        };
        let outcome = match outcome {
            Outcome::Confirmed(b) if !save.acknowledges(&b) => Outcome::Unknown(
                "Save response did not validate the captured source, base and content.",
            ),
            value => value,
        };
        a.outcome = outcome;
        if let Outcome::Confirmed(b) = &a.outcome {
            self.known = Some(a.clone());
            if let Some(d) = &mut self.draft
                && d.serial == a.serial
                && d.text == save.markdown
            {
                d.base = b.revision.number;
                d.original = b.markdown.clone();
                d.text = b.markdown.clone();
                d.reviewed = true;
            }
            let current = Current {
                source: self.source.clone(),
                brief: Some(b.clone()),
            };
            if self
                .current
                .as_ref()
                .is_none_or(|old| old.number() <= current.number())
            {
                self.current = Some(current);
            }
        } else if let Outcome::Rejected(_) = a.outcome
            && let Some(d) = &mut self.draft
        {
            d.reviewed = true;
        }
        true
    }
}
#[derive(Default, Debug)]
pub(crate) struct Book {
    pub(crate) entries: Vec<Entry>,
}
impl Book {
    pub(crate) fn ensure(&mut self, source: &Source) -> Result<usize, &'static str> {
        if let Some(ix) = self.entries.iter().position(|e| e.source == *source) {
            return Ok(ix);
        }
        if !source.valid() || self.entries.len() >= DRAFT_COUNT {
            return Err(
                "Brief workspace capacity reached or source is invalid. Existing drafts were retained.",
            );
        }
        self.entries.push(Entry {
            source: source.clone(),
            current: None,
            draft: None,
            attempt: None,
            known: None,
            unconfirmed: Vec::new(),
        });
        Ok(self.entries.len() - 1)
    }
    pub(crate) fn get(&self, source: &Source) -> Option<&Entry> {
        self.entries.iter().find(|e| e.source == *source)
    }
    pub(crate) fn get_mut(&mut self, source: &Source) -> Option<&mut Entry> {
        self.entries.iter_mut().find(|e| e.source == *source)
    }
    pub(crate) fn begin(&mut self, source: &Source) -> Result<Save, &'static str> {
        if self.entries.iter().any(Entry::pending) {
            return Err("Another brief save is pending. No save was queued.");
        }
        self.get_mut(source)
            .ok_or("Brief source is not open.")?
            .begin()
    }
    pub(crate) fn finish(&mut self, save: &Save, outcome: Outcome) -> bool {
        self.get_mut(&save.source)
            .is_some_and(|entry| entry.finish(save, outcome))
    }
    pub(crate) fn stopped(&mut self) {
        for e in &mut self.entries {
            if let Some(save) = e
                .attempt
                .as_ref()
                .filter(|a| matches!(a.outcome, Outcome::Pending))
                .map(|a| a.save.clone())
            {
                e.finish(
                    &save,
                    Outcome::Unknown(
                        "Couldn't confirm the save. Check the latest brief before saving again.",
                    ),
                );
            }
        }
    }
}
