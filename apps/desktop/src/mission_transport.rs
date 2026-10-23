//! Existing Local mission routes only. No automatic mutation replay or retries.
use crate::{
    LocalOptions,
    delivery_store::{Failure, Store, token},
    mission_conversion::{Action, Inspection, Outcome, Target},
};
use serde_json::Value;

async fn body(mut response: reqwest::Response) -> Result<Value, Failure> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Mission response interrupted")?
    {
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            return Err("Mission response exceeds the bounded reader limit");
        }
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Mission response is invalid")
}

async fn get(
    client: &reqwest::Client,
    options: &LocalOptions,
    path: &str,
) -> Result<Value, Failure> {
    let response = client
        .get(format!("{}{path}", options.loopback()))
        .send()
        .await
        .map_err(|_| "Local mission lookup interrupted")?;
    if response.status() != reqwest::StatusCode::OK {
        return Err("Local mission lookup unavailable");
    }
    body(response).await
}

async fn source(
    client: &reqwest::Client,
    options: &LocalOptions,
    target: &Target,
) -> Result<Value, Failure> {
    if !token(&target.source) || !token(&target.project) {
        return Err("An exact Local chat and project are required");
    }
    let source = get(client, options, &format!("/api/sessions/{}", target.source)).await?;
    if source["id"] != target.source || source["projectId"] != target.project {
        return Err("Local chat or project identity changed. Reopen from the source chat.");
    }
    Ok(source)
}

async fn admit(
    client: &reqwest::Client,
    options: &LocalOptions,
    target: &Target,
) -> Result<String, Failure> {
    let hello = crate::local_client::hello(client, options).await?;
    if hello["capabilities"]["guardedMissionConversion"] != true {
        return Err(
            "This Local daemon does not support safe chat conversion. Update it before making a mission.",
        );
    }
    let source = source(client, options, target).await?;
    if !crate::local_model::interactive_local(&source) || !source["missionId"].is_null() {
        return Err("Only an ordinary, unlinked, writable Local chat can become a mission");
    }
    let project = get(
        client,
        options,
        &format!("/api/projects/{}", target.project),
    )
    .await?;
    if project["id"] != target.project {
        return Err("The exact Local project is unavailable");
    }
    Ok(source["title"]
        .as_str()
        .unwrap_or("New mission")
        .chars()
        .take(200)
        .collect())
}

async fn observe(
    client: &reqwest::Client,
    options: &LocalOptions,
    target: &Target,
) -> Result<Inspection, Failure> {
    crate::local_client::gate(client, options).await?;
    let source = source(client, options, target).await?;
    let mission_id = if source["missionId"].is_null() {
        None
    } else {
        let id = source["missionId"]
            .as_str()
            .filter(|id| token(id))
            .ok_or("Invalid source membership")?;
        let detail = get(client, options, &format!("/api/missions/{id}")).await?;
        if detail["mission"]["id"] != id || detail["mission"]["projectId"] != target.project {
            return Err("Source membership and mission identity differ");
        }
        Some(id.into())
    };
    // Membership is evidence of CURRENT association, not this request's receipt.
    Ok(Inspection::Membership { mission_id })
}

pub(crate) async fn execute(
    client: &reqwest::Client,
    options: &LocalOptions,
    store: &mut Store,
    target: &Target,
    action: Action,
    prepared: impl FnOnce(&Store),
) -> Result<Inspection, Failure> {
    match action {
        Action::Inspect if !store.book.missions.contains_key(&target.source) => {
            Ok(Inspection::Ready {
                title: admit(client, options, target).await?,
            })
        }
        Action::Inspect | Action::Check => observe(client, options, target).await,
        Action::Submit { id, request } => {
            request.validate()?;
            if request.from_session_id != target.source || request.project_id != target.project {
                return Err("Captured mission source changed");
            }
            admit(client, options, target).await?;
            let attempt = store.prepare_mission(&id, request)?;
            prepared(store);
            let response = client
                .post(format!("{}/api/missions", options.loopback()))
                .header("Content-Type", "application/json")
                .body(
                    serde_json::to_vec(&attempt.request)
                        .map_err(|_| "Cannot encode mission request")?,
                )
                .send()
                .await;
            let Ok(response) = response else {
                return Ok(Inspection::Uncertain);
            };
            // Even a non-201 response is not proof of pre-commit rejection:
            // response construction/durability can fail after creation. Never retry.
            if response.status() != reqwest::StatusCode::CREATED {
                return Ok(Inspection::Uncertain);
            }
            let Ok(value) = body(response).await else {
                return Ok(Inspection::Uncertain);
            };
            let Some(mission_id) = value["mission"]["id"].as_str().filter(|id| token(id)) else {
                return Ok(Inspection::Uncertain);
            };
            if value["mission"]["projectId"] != target.project {
                return Ok(Inspection::Uncertain);
            }
            retain_receipt(store, target, &id, mission_id)
        }
    }
}

fn retain_receipt(
    store: &mut Store,
    target: &Target,
    attempt: &str,
    mission_id: &str,
) -> Result<Inspection, Failure> {
    let saved = store.finish_mission(
        &target.source,
        attempt,
        Outcome::Created {
            mission_id: mission_id.into(),
        },
    );
    if let Err(error) = saved
        && !store.is_faulted()
    {
        return Err(error);
    }
    // A known daemon 201 is not undone by failure of our private receipt write.
    // Keep its ID in the reply; the worker separately exposes the writer fault.
    Ok(Inspection::Created {
        mission_id: mission_id.into(),
    })
}

#[cfg(test)]
#[path = "mission_transport_tests.rs"]
mod tests;
