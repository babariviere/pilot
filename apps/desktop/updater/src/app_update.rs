//! App-payload authority is not daemon-management authority. External connections
//! are pinned with GET-only hello checks; they never acquire a runtime reservation.
use crate::{
    Error,
    coordination::{self, Guard, Location},
    installer::{self, NativePlatform, Platform},
    manifest::Trust,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    io::Read,
    path::{Path, PathBuf},
    time::Duration,
};

#[derive(Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Connection {
    location: Location,
    daemon: String,
    lineage: String,
}
impl Connection {
    pub fn new(location: Location, daemon: String, lineage: String) -> Self {
        Self {
            location,
            daemon,
            lineage,
        }
    }
    pub fn location(&self) -> &Location {
        &self.location
    }
    pub fn daemon(&self) -> &str {
        &self.daemon
    }
    pub fn lineage(&self) -> &str {
        &self.lineage
    }
    pub fn verify(&self) -> Result<(), Error> {
        if self.location.port == 0 || !self.location.home.is_absolute() {
            return Err(Error::Identity);
        }
        for (name, expected) in [
            ("daemon-id", &self.daemon),
            ("storage-lineage", &self.lineage),
        ] {
            if expected.is_empty()
                || expected.len() > 256
                || std::str::from_utf8(&crate::iteration::read(
                    &self.location.home.join(name),
                    4096,
                )?)
                .map_err(|_| Error::Identity)?
                .trim()
                    != expected
            {
                return Err(Error::Identity);
            }
        }
        let client = reqwest::blocking::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(2))
            .timeout(Duration::from_secs(5))
            .build()
            .map_err(|_| Error::Native)?;
        let mut response = client
            .get(format!("http://127.0.0.1:{}/api/hello", self.location.port))
            .send()
            .map_err(|_| Error::RuntimeUnverified)?;
        if response.status() != reqwest::StatusCode::OK {
            return Err(Error::RuntimeUnverified);
        }
        let mut bytes = Vec::new();
        response
            .by_ref()
            .take(16_385)
            .read_to_end(&mut bytes)
            .map_err(|_| Error::RuntimeUnverified)?;
        if bytes.len() > 16_384 {
            return Err(Error::Identity);
        }
        let hello: Value = serde_json::from_slice(&bytes).map_err(|_| Error::Identity)?;
        self.verify_hello(&hello)
    }
    fn verify_hello(&self, hello: &Value) -> Result<(), Error> {
        if hello["daemonId"] != self.daemon
            || hello["lineageId"] != self.lineage
            || hello["protocolVersion"].as_u64().is_none_or(|v| v < 1)
            || hello["minimumClientProtocolVersion"]
                .as_u64()
                .is_none_or(|v| v > 1)
            || hello["capabilities"]["independentExecution"] != true
        {
            return Err(Error::Identity);
        }
        Ok(())
    }
}

fn verify_independent(connection: &Connection, target: &Path) -> Result<(), Error> {
    let record = connection.location.home.join(".daemon-owner.json");
    if record.try_exists().map_err(|_| Error::Filesystem)? {
        let value: Value = serde_json::from_slice(&crate::iteration::read(&record, 16_384)?)
            .map_err(|_| Error::Identity)?;
        if let Some(root) = value["runtimeRoot"].as_str() {
            let root = Path::new(root)
                .canonicalize()
                .map_err(|_| Error::RuntimeUnverified)?;
            if root.starts_with(target) {
                return Err(Error::RuntimeUnverified);
            }
        }
    }
    Ok(())
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExternalGuard {
    connection: Connection,
    transaction: PathBuf,
    target: PathBuf,
    build: String,
    configuration: String,
}
pub enum ExitGuard {
    Retained(Guard),
    External {
        connection: Connection,
        target: PathBuf,
    },
}
impl ExitGuard {
    pub fn prepare_external(
        connection: Connection,
        target: &Path,
        transaction: &Path,
        build: &str,
        trust: &Trust,
    ) -> Result<Self, Error> {
        connection.verify()?;
        verify_independent(&connection, target)?;
        let guard = ExternalGuard {
            connection: connection.clone(),
            transaction: transaction.into(),
            target: target.into(),
            build: build.into(),
            configuration: coordination::configuration(trust),
        };
        let path = transaction.join("app-guard.json");
        let value = serde_json::to_value(&guard).map_err(|_| Error::Identity)?;
        if path.try_exists().map_err(|_| Error::Filesystem)? {
            if coordination::private_json(&path, 16_384)? != value {
                return Err(Error::Identity);
            }
        } else {
            installer::write_new(
                &path,
                &serde_json::to_vec(&guard).map_err(|_| Error::Identity)?,
            )?;
        }
        Ok(Self::External {
            connection,
            target: target.into(),
        })
    }
    pub fn load(
        transaction: &Path,
        candidate: &Path,
        build: &str,
        trust: &Trust,
    ) -> Result<Self, Error> {
        let located = installer::transaction_path(transaction)?;
        if located
            .join("app-guard.json")
            .try_exists()
            .map_err(|_| Error::Filesystem)?
        {
            let guard: ExternalGuard = serde_json::from_value(coordination::private_json(
                &located.join("app-guard.json"),
                16_384,
            )?)
            .map_err(|_| Error::Identity)?;
            if guard.transaction != transaction
                || guard.build != build
                || guard.configuration != coordination::configuration(trust)
            {
                return Err(Error::Identity);
            }
            guard.connection.verify()?;
            verify_independent(&guard.connection, &guard.target)?;
            Ok(Self::External {
                connection: guard.connection,
                target: guard.target,
            })
        } else {
            Guard::load(transaction, candidate, build, trust).map(Self::Retained)
        }
    }
    pub fn verify(&self) -> Result<(), Error> {
        match self {
            Self::Retained(g) => g.verify(),
            Self::External { connection, target } => {
                connection.verify()?;
                verify_independent(connection, target)
            }
        }
    }
    pub fn cancel(&self) {
        if let Self::Retained(g) = self {
            g.cancel();
        }
    }
    pub fn external_startup(
        transaction: &Path,
        target: &Path,
        trust: &Trust,
    ) -> Result<Option<Connection>, Error> {
        if !installer::transaction_path(transaction)?
            .join("app-guard.json")
            .try_exists()
            .map_err(|_| Error::Filesystem)?
        {
            return Ok(None);
        }
        NativePlatform.verify(target, trust, &trust.current_build, None)?;
        match Self::load(transaction, target, &trust.current_build, trust)? {
            Self::External {
                connection,
                target: recorded,
            } if recorded == target => Ok(Some(connection)),
            _ => Err(Error::Identity),
        }
    }
    pub fn acknowledge_startup(
        transaction: &Path,
        target: &Path,
        trust: &Trust,
    ) -> Result<(), Error> {
        if Self::external_startup(transaction, target, trust)?.is_some() {
            installer::acknowledge_startup(
                transaction,
                &trust.current_build,
                trust,
                &NativePlatform,
                target,
            )?;
            return Ok(());
        }
        // Old managed update receipts keep their original reservation semantics.
        Guard::acknowledge_startup(transaction, target, trust)
    }
}

/// Durable view tokens only. No commands, pending sends or queued actions are replayed.
pub fn save_navigation(transaction: &Path, navigation: &Value) -> Result<(), Error> {
    if installer::recovery_phase(transaction)? != installer::Phase::Ready {
        return Err(Error::RecoveryRequired);
    }
    let bytes = serde_json::to_vec(navigation).map_err(|_| Error::Identity)?;
    if bytes.len() > 16_384 {
        return Err(Error::Identity);
    }
    installer::write_new(&transaction.join("ui-state.pending"), &bytes)?;
    std::fs::rename(
        transaction.join("ui-state.pending"),
        transaction.join("ui-state.json"),
    )
    .map_err(|_| Error::Filesystem)?;
    std::fs::File::open(transaction)
        .and_then(|file| file.sync_all())
        .map_err(|_| Error::Filesystem)
}
pub fn navigation(transaction: &Path) -> Result<Value, Error> {
    let located = installer::transaction_path(transaction)?;
    let transaction = located.as_path();
    if !transaction
        .join("ui-state.json")
        .try_exists()
        .map_err(|_| Error::Filesystem)?
    {
        return Ok(Value::Null);
    }
    coordination::private_json(&transaction.join("ui-state.json"), 16_384)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn external_identity_and_protocol_are_exact() {
        let c = Connection::new(
            Location {
                home: "/synthetic".into(),
                port: 1,
                policy: Default::default(),
            },
            "Daemon-ID".into(),
            "Lineage-ID".into(),
        );
        let hello = serde_json::json!({"daemonId":"Daemon-ID","lineageId":"Lineage-ID","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}});
        assert!(c.verify_hello(&hello).is_ok());
        for (field, value) in [
            ("daemonId", serde_json::json!("daemon-id")),
            ("lineageId", serde_json::json!("other")),
            ("minimumClientProtocolVersion", serde_json::json!(2)),
            ("protocolVersion", Value::Null),
        ] {
            let mut bad = hello.clone();
            bad[field] = value;
            assert_eq!(c.verify_hello(&bad), Err(Error::Identity));
        }
    }
    #[test]
    fn external_app_updates_and_next_update_only_get_hello() {
        use std::{
            fs,
            io::{BufRead, Write},
            net::TcpListener,
        };
        let temp = crate::owned_tests::Temp::new();
        let home = temp.path().join("external-profile");
        fs::create_dir(&home).unwrap();
        fs::write(home.join("daemon-id"), "Daemon-ID\n").unwrap();
        fs::write(home.join("storage-lineage"), "Lineage-ID\n").unwrap();
        // Swift-owned record: intentionally no retained root/build/proof authority.
        let record = b"{\"build\":null}";
        fs::write(home.join(".daemon-owner.json"), record).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let server = std::thread::spawn(move || {
            let mut methods = Vec::new();
            for _ in 0..4 {
                let (mut socket, _) = listener.accept().unwrap();
                socket
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = std::io::BufReader::new(socket.try_clone().unwrap());
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                methods.push(line);
                loop {
                    let mut line = String::new();
                    reader.read_line(&mut line).unwrap();
                    if line == "\r\n" {
                        break;
                    }
                }
                let body = r#"{"daemonId":"Daemon-ID","lineageId":"Lineage-ID","protocolVersion":1,"minimumClientProtocolVersion":1,"capabilities":{"independentExecution":true}}"#;
                write!(
                    socket,
                    "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                    body.len(),
                    body
                )
                .unwrap();
            }
            methods
        });
        let connection = Connection::new(
            Location {
                home: home.clone(),
                port,
                policy: Default::default(),
            },
            "Daemon-ID".into(),
            "Lineage-ID".into(),
        );
        let target = temp.path().join("Pilot Next.app");
        let transaction = temp.path().join("first");
        fs::create_dir(&transaction).unwrap();
        let trust = crate::owned_tests::trust();
        let guard =
            ExitGuard::prepare_external(connection.clone(), &target, &transaction, "101.1", &trust)
                .unwrap();
        guard.verify().unwrap();
        guard.cancel(); // cancellation has no daemon request
        assert!(!transaction.join("runtime-guard.json").exists());
        assert!(ExitGuard::load(&transaction, &target, "999.1", &trust).is_err());
        ExitGuard::load(&transaction, &target, "101.1", &trust).unwrap();
        let mut next_trust = trust.clone();
        next_trust.current_build = "101.1".into();
        let next = temp.path().join("normal-next");
        fs::create_dir(&next).unwrap();
        ExitGuard::prepare_external(connection.clone(), &target, &next, "102.1", &next_trust)
            .unwrap();
        fs::write(home.join("storage-lineage"), "changed").unwrap();
        assert!(connection.verify().is_err());
        assert_eq!(fs::read(home.join(".daemon-owner.json")).unwrap(), record);
        assert_eq!(
            server.join().unwrap(),
            vec!["GET /api/hello HTTP/1.1\r\n"; 4]
        );
    }
}
