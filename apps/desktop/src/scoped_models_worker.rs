//! Lazy one-thread, one-command Local scope courier; no background mutation replay.
use crate::{
    LocalOptions,
    delivery_store::Failure,
    scoped_models::{self, Reply, Save},
};
pub(crate) enum Command {
    Read(u64),
    Save(u64, Save),
}
pub(crate) struct Update(pub(crate) u64, pub(crate) Reply);
pub(crate) struct Worker {
    commands: async_channel::Sender<Command>,
}
impl Worker {
    #[cfg(feature = "native-probes")]
    pub(crate) fn disconnect_fixture(&self) {
        self.commands.close();
    }
    pub(crate) fn start(
        options: LocalOptions,
    ) -> Result<(Self, async_channel::Receiver<Update>), Failure> {
        let (commands, input) = async_channel::bounded(1);
        let (output, updates) = async_channel::bounded(1);
        std::thread::Builder::new()
            .name("local-scoped-models".into())
            .spawn(move || {
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_all()
                    .build();
                let client = reqwest::Client::builder()
                    .no_proxy()
                    .retry(reqwest::retry::never())
                    .redirect(reqwest::redirect::Policy::none())
                    .connect_timeout(std::time::Duration::from_secs(2))
                    .timeout(std::time::Duration::from_secs(5))
                    .build();
                while let Ok(command) = input.recv_blocking() {
                    let id = match &command {
                        Command::Read(id) | Command::Save(id, _) => *id,
                    };
                    let reply = match (&runtime, &client) {
                        (Ok(runtime), Ok(client)) => runtime.block_on(async {
                            match command {
                                Command::Read(_) => Reply {
                                    observation: scoped_models::read(client, &options).await,
                                    problem: None,
                                    attempted: false,
                                },
                                Command::Save(_, request) => {
                                    scoped_models::save(client, &options, request).await
                                }
                            }
                        }),
                        _ => Reply {
                            observation: Err("Cannot start the bounded Local model worker."),
                            problem: None,
                            attempted: false,
                        },
                    };
                    if output.send_blocking(Update(id, reply)).is_err() {
                        break;
                    }
                }
            })
            .map_err(|_| "Cannot start the bounded Local model worker.")?;
        Ok((Self { commands }, updates))
    }
    pub(crate) fn command(&self, c: Command) -> bool {
        self.commands.try_send(c).is_ok()
    }
}
impl Drop for Worker {
    fn drop(&mut self) {
        self.commands.close();
    }
}
