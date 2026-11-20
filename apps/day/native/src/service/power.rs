//! Pilot's pause for sleep, as the service last reported it on its event
//! stream, and the user's Resume. Resuming twice changes nothing, so Resume
//! is one direct request, not a journaled operation.
use super::{Error, Shared, Transport};
use serde_json::{Value, json};

/// What the window shows: whether work is paused for sleep, and since when (epoch ms).
pub(super) fn view(status: &Value) -> Value {
    let paused = status["paused"] == true;
    let since = status["pausedSince"].as_u64().filter(|_| paused);
    json!({"paused": paused, "since": since})
}

/// Keeps a power frame's status, and tells the window only when what it shows changed.
pub(super) fn observe(shared: &Shared, status: &Value) {
    let next = view(status);
    {
        let mut power = shared.power.lock().expect("native power poisoned");
        if *power == next {
            return;
        }
        *power = next;
    }
    shared.change(|_| ());
}

/// The user's Resume: the service ends its pause for sleep now.
pub(super) async fn resume(t: &Transport, shared: &Shared) -> Result<Value, Error> {
    t.profile_gate().await?;
    let status = t.power_resume().await?;
    observe(shared, &status);
    Ok(json!({"snapshot": view(&status), "outcome": null}))
}

#[cfg(test)]
mod tests {
    use super::view;
    use serde_json::json;

    #[test]
    fn the_window_sees_only_the_pause_and_its_start() {
        assert_eq!(
            view(&json!({"paused":true,"pausedSince":1794842480065_u64,"keepingAwake":false})),
            json!({"paused":true,"since":1794842480065_u64})
        );
        assert_eq!(
            view(&json!({"paused":false,"pausedSince":5})),
            json!({"paused":false,"since":null})
        );
        assert_eq!(view(&json!(null)), json!({"paused":false,"since":null}));
    }
}
