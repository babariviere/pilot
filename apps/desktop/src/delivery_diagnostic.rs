//! Fixed vocabulary only. Never store an HTTP body, exception, path or rejection.reason.
use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Stage {
    Identity,
    Target,
    Lookup,
    Execute,
    Adoption,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Category {
    InFlight,
    Interrupted,
    Refused,
    ResponseInterrupted,
    TooLarge,
    Malformed,
    Identity,
    ReceiptMismatch,
    Unknown,
    Pending,
    Accepted,
    Rejected,
    PrivateWrite,
    PrivateCapacity,
    PrivateState,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum Acknowledgment {
    Unknown,
    Pending,
    Accepted,
    Rejected,
}
#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Diagnostic {
    pub(crate) stage: Stage,
    pub(crate) category: Category,
    pub(crate) status: Option<u16>,
    pub(crate) acknowledgment: Acknowledgment,
}
impl Diagnostic {
    pub(crate) fn started(stage: Stage) -> Self {
        Self {
            stage,
            category: Category::InFlight,
            status: None,
            acknowledgment: Acknowledgment::Unknown,
        }
    }
    pub(crate) fn validate(&self) -> Result<(), super::Failure> {
        if self
            .status
            .is_some_and(|status| !(100..=999).contains(&status))
        {
            return Err("Stored delivery status is invalid");
        }
        Ok(())
    }
    pub(crate) fn caption(&self) -> String {
        let stage = match self.stage {
            Stage::Identity => "Local verification",
            Stage::Target => "Chat verification",
            Stage::Lookup => "Receipt check",
            Stage::Execute => "Delivery request",
            Stage::Adoption => "Private receipt save",
        };
        let category = match self.category {
            Category::InFlight => "Waiting for Local",
            Category::Interrupted => "Request interrupted",
            Category::Refused => "Local refused the request",
            Category::ResponseInterrupted => "Reply interrupted",
            Category::TooLarge => "Reply exceeded the size limit",
            Category::Malformed => "Invalid Local reply",
            Category::Identity => "Local identity or access not verified",
            Category::ReceiptMismatch => "Receipt identity did not match",
            Category::Unknown => "No Local receipt",
            Category::Pending => "Local owns this delivery",
            Category::Accepted => "Local accepted this delivery",
            Category::Rejected => "Local rejected this delivery",
            Category::PrivateWrite => "Private write failed",
            Category::PrivateCapacity => "Private storage is full",
            Category::PrivateState => "Private adoption was not completed",
        };
        let acknowledgment = match self.acknowledgment {
            Acknowledgment::Unknown => "delivery unconfirmed",
            Acknowledgment::Pending => "Local pending",
            Acknowledgment::Accepted => "Local accepted",
            Acknowledgment::Rejected => "Local rejected",
        };
        let status = self
            .status
            .map(|n| format!(" · HTTP {n}"))
            .unwrap_or_default();
        if matches!(
            self.category,
            Category::Pending | Category::Accepted | Category::Rejected
        ) {
            return format!("{stage}{status}: {acknowledgment}.");
        }
        format!("{stage}{status}: {category}; {acknowledgment}.")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delivery_diagnostic_vocabulary_is_bounded_and_rejects_untyped_fields() {
        let d = Diagnostic {
            stage: Stage::Adoption,
            category: Category::PrivateCapacity,
            status: Some(503),
            acknowledgment: Acknowledgment::Accepted,
        };
        assert!(serde_json::to_vec(&d).unwrap().len() < 256);
        assert!(d.caption().len() < 192);
        let mut value = serde_json::to_value(d).unwrap();
        value["body"] = "never retain arbitrary details".into();
        assert!(serde_json::from_value::<Diagnostic>(value).is_err());
        assert!(
            Diagnostic {
                status: Some(0),
                ..d
            }
            .validate()
            .is_err()
        );
    }
}
