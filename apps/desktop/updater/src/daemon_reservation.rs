//! Exact daemon-safe receipt. Never reconstructed from a journal or renewed.
use super::Failure;
use crate::coordination::{self, Location};
use serde_json::{Value, json};
use std::time::{Duration, Instant};

pub(super) struct Reservation {
    pub(super) receipt: Value,
    deadline: Instant,
}
impl Reservation {
    pub(super) fn prepare(location: &Location, owner: &Value) -> Result<Self, Failure> {
        if owner["runtimeRoot"]
            .as_str()
            .is_none_or(|r| !std::path::Path::new(r).is_absolute())
            || !owner["build"].is_object()
        {
            return Err(Failure::Unverified);
        }
        // Server hold is 180s measured before inspection (which may take 10s).
        // Keep five seconds of margin; verify never renews this local deadline.
        let deadline = Instant::now() + Duration::from_secs(175);
        let request = json!({"operationId":coordination::random_operation().map_err(|_|Failure::Unverified)?,"purpose":"daemon-upgrade"});
        let receipt =
            coordination::signed_update(location, owner, &request, "prepare").map_err(failure)?;
        validate_receipt(&receipt, &request)?;
        let value = Self { receipt, deadline };
        if let Err(error) = value.fresh() {
            value.cancel(location, owner);
            return Err(error);
        }
        Ok(value)
    }
    pub(super) fn fresh(&self) -> Result<(), Failure> {
        if Instant::now() >= self.deadline {
            Err(Failure::Busy)
        } else {
            Ok(())
        }
    }
    pub(super) fn verify(&self, location: &Location, owner: &Value) -> Result<(), Failure> {
        self.fresh()?;
        if coordination::signed_update(location, owner, &self.receipt, "verify").map_err(failure)?
            != self.receipt
        {
            return Err(Failure::Unverified);
        }
        self.fresh()
    }
    pub(super) fn cancel(&self, location: &Location, owner: &Value) {
        // A failed/lost cancel ACK is not permission to stop. Orphan holds expire.
        let _ = coordination::signed_update(location, owner, &self.receipt, "cancel");
    }
}
fn failure(error: crate::Error) -> Failure {
    if matches!(error, crate::Error::ActiveWork) {
        Failure::Busy
    } else {
        Failure::Unverified
    }
}
fn validate_receipt(receipt: &Value, request: &Value) -> Result<(), Failure> {
    if receipt.as_object().is_none_or(|v| v.len() != 4)
        || receipt["schema"] != 1
        || receipt["operationId"] != request["operationId"]
        || receipt["purpose"] != "daemon-upgrade"
        || receipt["token"].as_str().is_none_or(|s| {
            s.len() != 64
                || !s
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        })
    {
        return Err(Failure::Unverified);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn old_gui_receipt_wrong_operation_and_missing_token_refuse() {
        let request = json!({"operationId":"new","purpose":"daemon-upgrade"});
        let exact = json!({"schema":1,"operationId":"new","purpose":"daemon-upgrade","token":"a".repeat(64)});
        assert_eq!(validate_receipt(&exact, &request), Ok(()));
        for (field, value) in [
            ("purpose", Value::Null),
            ("operationId", json!("old")),
            ("token", json!("?".repeat(64))),
        ] {
            let mut changed = exact.clone();
            changed[field] = value;
            assert_eq!(
                validate_receipt(&changed, &request),
                Err(Failure::Unverified)
            );
        }
    }
    #[test]
    fn local_deadline_is_nonrenewable() {
        let expired = Reservation {
            receipt: Value::Null,
            deadline: Instant::now() - Duration::from_secs(1),
        };
        assert_eq!(expired.fresh(), Err(Failure::Busy));
    }
}

#[cfg(test)]
mod channel_tests {
    use super::*;
    use ring::hmac;
    use sha2::{Digest, Sha256};
    use std::{
        fs,
        io::{Read, Write},
        net::TcpListener,
        os::unix::fs::PermissionsExt,
    };
    #[test]
    fn signed_channel_requires_exact_identity_mac_operation_and_purpose() {
        for fault in [
            "none",
            "purpose",
            "operation",
            "token",
            "mac",
            "boot",
            "home",
            "port",
            "build",
            "runtimeRoot",
            "refuse",
            "lost",
        ] {
            let temp = crate::owned_tests::Temp::new();
            let home = temp.path().canonicalize().unwrap();
            fs::set_permissions(&home, fs::Permissions::from_mode(0o700)).unwrap();
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let owner = json!({"schema":1,"boot":"a".repeat(64),"secret":"b".repeat(64),"home":crate::transport::hex(&Sha256::digest(home.to_str().unwrap().as_bytes())),"port":port,"pid":std::process::id(),"build":{"source":"a".repeat(40)},"runtimeRoot":"/retained/runtime"});
            crate::installer::write_new(
                &home.join(".daemon-owner.json"),
                &serde_json::to_vec(&owner).unwrap(),
            )
            .unwrap();
            let response_owner = owner.clone();
            let worker = std::thread::spawn(move || {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(3)))
                    .unwrap();
                let mut bytes = Vec::new();
                let (header_end, len) = loop {
                    let mut buffer = [0; 2048];
                    let count = socket.read(&mut buffer).unwrap();
                    assert!(count > 0);
                    bytes.extend_from_slice(&buffer[..count]);
                    if let Some(end) = bytes.windows(4).position(|v| v == b"\r\n\r\n") {
                        let headers = String::from_utf8_lossy(&bytes[..end]);
                        let len = headers
                            .lines()
                            .find_map(|l| {
                                l.to_ascii_lowercase()
                                    .strip_prefix("content-length: ")
                                    .map(|v| v.parse::<usize>().unwrap())
                            })
                            .unwrap();
                        break (end + 4, len);
                    }
                };
                while bytes.len() < header_end + len {
                    let mut b = [0; 2048];
                    let n = socket.read(&mut b).unwrap();
                    assert!(n > 0);
                    bytes.extend_from_slice(&b[..n]);
                }
                let request: Value = serde_json::from_slice(&bytes[header_end..]).unwrap();
                assert_eq!(request["action"], "prepare");
                assert_eq!(request["receipt"]["purpose"], "daemon-upgrade");
                let key = hmac::Key::new(hmac::HMAC_SHA256, &[0xbb; 32]);
                let headers = String::from_utf8_lossy(&bytes[..header_end]);
                let proof = crate::transport::hex(
                    hmac::sign(
                        &key,
                        format!(
                            "update/v1\n{}",
                            String::from_utf8_lossy(&bytes[header_end..])
                        )
                        .as_bytes(),
                    )
                    .as_ref(),
                );
                assert!(
                    headers
                        .to_ascii_lowercase()
                        .contains(&format!("x-pilot-update-proof: {proof}"))
                );
                if fault == "lost" {
                    return;
                }
                if fault == "refuse" {
                    write!(
                        socket,
                        "HTTP/1.1 409 Conflict\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
                    )
                    .unwrap();
                    return;
                }
                let mut body = response_owner;
                body.as_object_mut().unwrap().remove("secret");
                body["nonce"] = request["nonce"].clone();
                body["receipt"] = json!({"schema":1,"operationId":request["receipt"]["operationId"],"purpose":"daemon-upgrade","token":"c".repeat(64)});
                if ["purpose", "operation", "token"].contains(&fault) {
                    let f = if fault == "operation" {
                        "operationId"
                    } else {
                        fault
                    };
                    body["receipt"][f] = json!("wrong");
                }
                if ["boot", "home", "port", "build", "runtimeRoot"].contains(&fault) {
                    body[fault] = json!("wrong");
                }
                let body = body.to_string();
                let mac = if fault == "mac" {
                    "d".repeat(64)
                } else {
                    crate::transport::hex(
                        hmac::sign(&key, format!("update/v1\n{body}").as_bytes()).as_ref(),
                    )
                };
                let response = json!({"body":body,"mac":mac}).to_string();
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{response}",
                    response.len()
                )
                .unwrap();
            });
            let result = Reservation::prepare(
                &Location {
                    home,
                    port,
                    policy: Default::default(),
                },
                &owner,
            );
            assert_eq!(result.is_ok(), fault == "none", "{fault}");
            worker.join().unwrap();
        }
    }
}
