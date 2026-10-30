//! Reported resource rows from one passive mission detail, without URL deduplication.
use crate::mission_browser::Task;
use serde_json::Value;
use std::{collections::HashSet, sync::Arc};

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct Resource {
    pub(crate) id: String,
    pub(crate) url: String,
    pub(crate) title: String,
    pub(crate) kind: String,
    pub(crate) task: Option<String>,
    pub(crate) task_label: String,
    pub(crate) task_available: bool,
    pub(crate) metadata: Vec<String>,
}
impl Resource {
    pub(crate) fn summary(&self) -> String {
        format!("{} · {}", self.kind, self.task_label)
    }
}
pub(crate) fn project(v: &Value, tasks: &[Task]) -> Result<Arc<Vec<Resource>>, &'static str> {
    let raw = v["resources"]
        .as_array()
        .ok_or("Links weren't included in this mission response.")?;
    let mut seen = HashSet::new();
    let mut rows = Vec::with_capacity(raw.len());
    for r in raw {
        let id = r["id"]
            .as_str()
            .filter(|s| crate::local_model::valid_id(s))
            .ok_or("Link identity is unavailable.")?;
        if !seen.insert(id) {
            return Err("Mission link identities are ambiguous.");
        }
        let url = r["url"].as_str().ok_or("Link URL is unavailable.")?;
        let optional = |name: &str| -> Result<Option<String>, &'static str> {
            match &r[name] {
                Value::Null => Ok(None),
                Value::String(s) => Ok(Some(s.clone())),
                _ => Err("Link metadata is malformed."),
            }
        };
        let task = optional("taskId")?;
        let target = tasks.iter().find(|t| Some(&t.id) == task.as_ref());
        let task_label = match (&task, target) {
            (_, Some(t)) => format!("Task #{} · {}", t.number, t.title),
            (Some(id), None) => format!("Task unavailable · {id}"),
            _ => "Mission-level link".into(),
        };
        let kind = optional("kind")?.unwrap_or_else(|| "Kind unavailable".into());
        let mut metadata = Vec::new();
        for (field, label) in [
            ("externalId", "Reported reference"),
            ("relationship", "Reported relationship"),
            ("linearRole", "Reported Linear role"),
            ("addedBySessionId", "Added by chat"),
        ] {
            if let Some(s) = optional(field)? {
                metadata.push(format!("{label}: {s}"));
            }
        }
        if kind == "github.pr" {
            // GET detail's resourceFrom does not supply the tool-only owner projection.
            metadata.push("PR chat binding unavailable in this mission read".into());
        }
        rows.push(Resource {
            id: id.into(),
            url: url.into(),
            title: optional("title")?
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| url.into()),
            kind,
            task,
            task_label,
            task_available: target.is_some(),
            metadata,
        });
    }
    Ok(Arc::new(rows))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn exact_refs_do_not_guess_task_numbers_titles_or_deduplicate_urls() {
        let mut v = crate::mission_browser_fixture::detail("mission-A");
        v["resources"] = json!([
            {"id":"a","url":"https://example.test/日本語?q=%20#x","taskId":"task-B","kind":"github.pr","relationship":"reference","addedBySessionId":"creator"},
            {"id":"b","url":"https://example.test/日本語?q=%20#x","taskId":"2","title":"Preserve the reader","kind":"url"},
            {"id":"c","url":"javascript:alert(1)","kind":"url"}
        ]);
        let d =
            crate::mission_browser::detail(&crate::mission_browser_fixture::key("mission-A"), &v)
                .unwrap();
        let rows = d.resources.unwrap();
        assert_eq!(rows.len(), 3);
        assert_eq!(rows[0].url, v["resources"][0]["url"]);
        assert_eq!(rows[0].task.as_deref(), Some("task-B"));
        assert!(rows[0].task_available);
        assert!(rows[0].metadata.contains(&"Added by chat: creator".into()));
        assert!(!rows[1].task_available);
        assert_eq!(rows[1].task.as_deref(), Some("2"));
        assert!(crate::external_links::web(&rows[2].url).is_none());
    }
    #[test]
    fn omitted_malformed_duplicate_empty_and_full_task_scope() {
        assert!(project(&json!({}), &[]).is_err());
        assert!(project(&json!({"resources":[]}), &[]).unwrap().is_empty());
        let link = json!({"id":"a","url":"https://example.test","kind":"url"});
        assert!(project(&json!({"resources":[link.clone(),link]}), &[]).is_err());
        assert!(project(&json!({"resources":[{"id":"a","url":2}]}), &[]).is_err());
        let mut v = crate::mission_browser_fixture::many("mission-A", 260);
        v["resources"] =
            json!([{"id":"a","url":"https://example.test","taskId":"task-B","kind":"url"}]);
        let d =
            crate::mission_browser::detail(&crate::mission_browser_fixture::key("mission-A"), &v)
                .unwrap();
        assert!(!d.tasks.iter().any(|t| t.id == "task-B"));
        assert!(d.resources.unwrap()[0].task_available);
    }

    #[test]
    fn unsafe_and_unsupported_urls_remain_exact_copyable_data() {
        for url in [
            "javascript:alert(1)",
            "file:///tmp/x",
            "pilot://chat/2",
            "https://user:password@example.test",
            "https://example.test/%0a",
            "https://example.test/\\x",
            "https://example.test/\u{202e}x",
            "not a URL",
        ] {
            let rows = project(
                &json!({"resources":[{"id":"a","url":url,"kind":"url"}]}),
                &[],
            )
            .unwrap();
            assert_eq!(rows[0].url, url);
            assert!(crate::external_links::web(&rows[0].url).is_none(), "{url}");
        }
    }
}
