use super::*;

impl LocalViewer {
    /// Shared in-app and native URL-open route. Never delegates internal URLs to the OS.
    pub fn open_chat_url(&mut self, url: &str, w: &mut Window, cx: &mut Context<Self>) {
        self.link_epoch += 1;
        self.link_read = None;
        let id = match crate::chat_links::target(url) {
            Ok(id) => id.to_owned(),
            Err(error) => {
                self.nav_error = Some(error);
                cx.notify();
                return;
            }
        };
        if !self.link_navigation_ready(w, cx) {
            return;
        }
        if let Some(chat) = self
            .state
            .chats
            .iter()
            .find(|c| c.id == id && !c.local_draft)
            .cloned()
        {
            self.finish_chat_link(chat, w, cx);
            return;
        }
        let Some(options) = self.usage_options.clone().filter(|_| self.client.is_some()) else {
            self.nav_error = Some("Chat unavailable. Connect to Local and open the link again.");
            cx.notify();
            return;
        };
        let epoch = self.link_epoch;
        let source = self.location(cx);
        let generation = self.generation;
        let read_options = options.clone();
        let (send, read) = async_channel::bounded(1);
        if std::thread::Builder::new().name("linked-chat-read".into()).spawn(move || {
            let result = tokio::runtime::Builder::new_current_thread().enable_all().build();
            match result {
                Ok(runtime) => runtime.block_on(async {
                    tokio::select! {
                        biased;
                        _ = send.closed() => {},
                        result = crate::local_client::linked_chat(&read_options, &id) => { let _ = send.try_send(result); },
                    }
                }),
                Err(_) => { let _ = send.try_send(Err("Cannot read this chat. Open the link again.")); }
            }
        }).is_err() {
            self.nav_error = Some("Cannot read this chat. Open the link again.");
            cx.notify();
            return;
        }
        self.nav_error = Some("Opening linked chat…");
        self.link_read = Some(cx.spawn_in(w, async move |view, cx| {
            let result = read
                .recv()
                .await
                .unwrap_or(Err("Chat reader stopped. Open the link again."));
            let _ = view.update_in(cx, |v, w, cx| {
                if v.link_epoch != epoch
                    || v.location(cx) != source
                    || v.generation != generation
                    || !v
                        .usage_options
                        .as_ref()
                        .is_some_and(|o| o.same_todo_source(&options))
                {
                    return;
                }
                match result {
                    Ok(chat) => {
                        if v.link_navigation_ready(w, cx) {
                            v.finish_chat_link(chat, w, cx);
                        }
                    }
                    Err(error) => {
                        v.nav_error = Some(error);
                        cx.notify();
                    }
                }
            });
        }));
        cx.notify();
    }
    fn link_navigation_ready(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        if !self.mission_navigation_ready(w, cx) {
            self.nav_error = Some(self.editor.read(cx).resource_navigation_issue().unwrap_or(
                "Finish editing or close the open dialog, then open the chat link again.",
            ));
            cx.notify();
            return false;
        }
        true
    }
    fn finish_chat_link(&mut self, chat: Chat, w: &mut Window, cx: &mut Context<Self>) {
        // Retain exact unloaded targets for history and sidebar synchronization.
        let previous = self.state.chats.clone();
        if !previous.iter().any(|c| c.id == chat.id) {
            let mut chats = previous.as_ref().clone();
            chats.push(chat.clone());
            self.state.chats = Arc::new(chats);
        }
        if self.open(chat, w, cx) {
            self.focus_mission_chat_destination(w, cx);
        } else {
            self.state.chats = previous;
        }
    }
}
