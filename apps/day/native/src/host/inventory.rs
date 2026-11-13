//! Passive inventory on the existing serialized worker. No journal or continuation.
use super::{Error, NativeHost, Shared, Transport, Work};
use crate::{
    model::IntentOutcome,
    plan::{PlanAvailability, Planning},
    plan_host,
};
use async_channel::Receiver;
use std::sync::atomic::Ordering;

impl NativeHost {
    /// Read every planning mission in the selected project, within the fixed limit.
    pub fn read_planning_inventory(&self) -> Receiver<Result<IntentOutcome, Error>> {
        self.0
            .shared
            .planning_inventory_wanted
            .store(true, Ordering::SeqCst);
        self.request(Work::PlanningInventory)
    }

    /// Projection only. Missing, failed and invalidated reads never mean an empty inventory.
    pub fn planning_inventory_snapshot(&self) -> Planning {
        let read = self
            .0
            .shared
            .planning_inventory
            .lock()
            .expect("planning inventory poisoned");
        let rows = read
            .as_ref()
            .and_then(|(_, value, _)| plan_host::inventory_rows(value).ok())
            .filter(|_| self.0.shared.open().is_ok());
        let live = read.as_ref().is_some_and(|(epoch, _, error)| {
            error.is_none()
                && self.0.shared.current(*epoch).is_ok()
                && self.0.shared.connected.load(Ordering::SeqCst)
        });
        let failed = matches!(
            self.0
                .shared
                .desk
                .lock()
                .expect("native Desk poisoned")
                .today()
                .freshness
                .state,
            crate::model::FreshnessState::Offline | crate::model::FreshnessState::Unavailable
        );
        let setup = self.planning_setup();
        Planning {
            availability: if live {
                PlanAvailability::Live
            } else if rows.is_some() && self.0.shared.open().is_ok() {
                PlanAvailability::Stale
            } else {
                PlanAvailability::Unavailable
            },
            reason: if live {
                String::new()
            } else if rows.is_some() {
                if failed
                    || read
                        .as_ref()
                        .is_some_and(|(_, _, error)| error.is_some_and(|e| e != Error::Stale))
                {
                    "Planning read failed. Showing the earlier complete read; read again.".into()
                } else {
                    "Reading changes. Showing the earlier complete planning read.".into()
                }
            } else {
                "Planning missions could not be read. Read again; nothing was started.".into()
            },
            can_create: setup.is_some(),
            create_reason: if setup.is_some() {
                String::new()
            } else {
                "Mission planning is not configured for this selection. Nothing was sent.".into()
            },
            setup: setup.unwrap_or_default(),
            can_start: false,
            start_reason:
                "Starting a standalone chat from Day is not connected yet. Nothing was sent.".into(),
            plans: rows.unwrap_or_default(),
            ..Planning::default()
        }
    }
}

pub(super) async fn read(t: &Transport, shared: &Shared, epoch: u64) -> Result<(), Error> {
    let result = async {
        t.gate(false).await?;
        let value = t.planning_inventory().await?;
        if value["projectId"] != t.source.project()?.project_id {
            return Err(Error::Identity);
        }
        plan_host::inventory_rows(&value)?;
        t.gate(false).await?;
        shared.current(epoch)?;
        Ok(value)
    }
    .await;
    // Clear a refused read even if no WS invalidation arrived (for example revoked owner).
    let mut snapshot = shared
        .planning_inventory
        .lock()
        .expect("planning inventory poisoned");
    match result {
        Ok(value) => {
            *snapshot = Some((epoch, value, None));
        }
        Err(error) => {
            // A notice/transport race does not erase a complete read. Authority
            // loss, invalid data and overflow do: never keep rows after denial.
            if matches!(error, Error::Stale | Error::Offline | Error::Unavailable) {
                if let Some((_, _, failed)) = snapshot.as_mut() {
                    *failed = Some(error);
                }
            } else {
                *snapshot = None;
            }
            drop(snapshot);
            shared.change(|_| ());
            return Err(error);
        }
    }
    drop(snapshot);
    shared.change(|_| ());
    Ok(())
}
