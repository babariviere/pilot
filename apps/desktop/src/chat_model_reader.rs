//! One retained read worker, coalesced one-slot mailboxes. No mutation capability.
#[cfg(test)]
#[path = "chat_model_reader_tests.rs"]
mod tests;
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
    pub(crate) catalog_generation: u64,
    pub(crate) scope: Scope,
    pub(crate) target: Option<Target>,
    pub(crate) refresh: bool,
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
type Catalogs = std::collections::HashMap<(Option<String>, String), (u64, Catalog)>;

async fn read(
    client: &reqwest::Client,
    options: &LocalOptions,
    request: &Request,
    catalogs: &mut Catalogs,
) -> Result<(Catalog, Option<SessionModel>), Failure> {
    let current = match &request.target {
        Some(target) => Some(crate::chat_models::session(client, options, target).await?),
        None => None,
    };
    let key = (request.scope.project.clone(), request.scope.cwd.clone());
    let catalog = if let Some((_, catalog)) = catalogs
        .get(&key)
        .filter(|(generation, _)| *generation == request.catalog_generation)
    {
        // Even a successful matching-scope cache hit must validate the pinned daemon.
        crate::chat_models::read_gate(client, options).await?;
        catalog.clone()
    } else {
        let catalog = crate::chat_models::catalog(client, options, &request.scope.cwd).await?;
        catalogs.insert(key, (request.catalog_generation, catalog.clone()));
        catalog
    };
    Ok((catalog, current))
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
    #[cfg(test)]
    pub(crate) fn pending(&self) -> Option<Request> {
        self.replace.try_recv().ok()
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
                        // This worker belongs to one pinned LocalOptions identity.
                        let mut catalogs = Catalogs::new();
                        let mut next = None;
                        loop {
                            let r = match next.take() {
                                Some(r) => r,
                                None => match input.recv().await {
                                    Ok(r) => r,
                                    Err(_) => break,
                                },
                            };
                            let key = (r.scope.project.clone(), r.scope.cwd.clone());
                            if r.refresh { catalogs.remove(&key); }
                            let result = tokio::select! { biased;
                                request = input.recv() => {
                                    match request {
                                        Ok(request) => next = Some(request),
                                        Err(_) => break,
                                    }
                                    continue;
                                }
                                result = async {
                                    let result = read(&client, &options, &r, &mut catalogs).await;
                                    // One recovery per open/switch/reconnect request, only for a
                                    // transport interruption. A newer selection cancels both attempts.
                                    if result.as_ref().is_err_and(|e| crate::chat_models::interrupted_read(e)) {
                                        read(&client, &options, &r, &mut catalogs).await
                                    } else {
                                        result
                                    }
                                } => result,
                            };
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
