//! One retained read worker, coalesced one-slot mailboxes. No mutation capability.
use crate::{
    LocalOptions,
    chat_models::{Catalog, SessionModel, Target},
    delivery_store::Failure,
};
#[derive(Clone, PartialEq, Eq)]
pub(crate) struct Scope {
    pub(crate) key: String,
    pub(crate) project: Option<String>,
    pub(crate) cwd: String,
}
pub(crate) struct Request {
    pub(crate) id: u64,
    pub(crate) scope: Scope,
    pub(crate) target: Option<Target>,
}
pub(crate) struct Update {
    pub(crate) id: u64,
    pub(crate) scope: Scope,
    pub(crate) result: Result<(Catalog, Option<SessionModel>), Failure>,
}
pub(crate) struct Reader {
    commands: async_channel::Sender<Request>,
    replace: async_channel::Receiver<Request>,
}
impl Reader {
    #[cfg(feature = "native-probes")]
    pub(crate) fn disconnect_fixture(&self) {
        self.commands.close();
    }
    #[cfg(test)]
    pub(crate) fn recording() -> Self {
        let (commands, replace) = async_channel::bounded(1);
        Self { commands, replace }
    }
    pub(crate) fn start(
        options: LocalOptions,
    ) -> Result<(Self, async_channel::Receiver<Update>), Failure> {
        let (commands, input) = async_channel::bounded::<Request>(1);
        let replace = input.clone();
        let (output, updates) = async_channel::bounded(1);
        let stale = updates.clone();
        std::thread::Builder::new()
            .name("scoped-chat-models".into())
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
                if let (Ok(runtime), Ok(client)) = (runtime, client) {
                    runtime.block_on(async {
                        while let Ok(r) = input.recv().await {
                            let result = async {
                                let current = match &r.target {
                                    Some(t) => Some(
                                        crate::chat_models::session(&client, &options, t).await?,
                                    ),
                                    None => None,
                                };
                                Ok((
                                    crate::chat_models::catalog(&client, &options, &r.scope.cwd)
                                        .await?,
                                    current,
                                ))
                            }
                            .await;
                            let u = Update {
                                id: r.id,
                                scope: r.scope,
                                result,
                            };
                            if let Err(async_channel::TrySendError::Full(u)) = output.try_send(u) {
                                let _ = stale.try_recv();
                                if output.try_send(u).is_err() {
                                    break;
                                }
                            }
                            if output.is_closed() {
                                break;
                            }
                        }
                    });
                }
            })
            .map_err(|_| "Cannot start the bounded model catalog reader.")?;
        Ok((Self { commands, replace }, updates))
    }
    pub(crate) fn request(&self, r: Request) -> bool {
        match self.commands.try_send(r) {
            Ok(()) => true,
            Err(async_channel::TrySendError::Full(r)) => {
                let _ = self.replace.try_recv();
                self.commands.try_send(r).is_ok()
            }
            Err(_) => false,
        }
    }
}
impl Drop for Reader {
    fn drop(&mut self) {
        self.commands.close();
    }
}
