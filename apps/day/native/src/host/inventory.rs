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
        let rows = read.as_ref().and_then(|(epoch, value)| {
            (self.0.shared.current(*epoch).is_ok()
                && self.0.shared.connected.load(Ordering::SeqCst))
            .then(|| plan_host::inventory_rows(value).ok())
            .flatten()
        });
        let setup = self.planning_setup();
        Planning {
            availability: if rows.is_some() {
                PlanAvailability::Live
            } else {
                PlanAvailability::Unavailable
            },
            reason: if rows.is_some() {
                String::new()
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
        if value["projectId"] != t.source.project_id {
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
            *snapshot = Some((epoch, value));
        }
        Err(error) => {
            *snapshot = None;
            drop(snapshot);
            shared.change(|_| ());
            return Err(error);
        }
    }
    drop(snapshot);
    shared.change(|_| ());
    Ok(())
}
