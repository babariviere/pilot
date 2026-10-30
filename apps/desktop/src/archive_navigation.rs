use super::*;
gpui_kit::actions!(archive_navigation, [Back]);
impl LocalViewer {
    pub(super) fn show_archive(&mut self, w: &mut Window, cx: &mut Context<Self>) -> bool {
        if !self.prepare_navigation(w, cx) {
            return false;
        }
        self.leave_artifacts(cx);
        self.page = Page::Archive;
        self.projects_open = false;
        self.nav_error = None;
        self.rebuild_nav(w, cx);
        self.archive.update(cx, |v, cx| v.focus(w, cx));
        self.did_navigate(cx);
        true
    }
    pub(super) fn refresh_archive(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.state.inventory_refreshing || !self.archive.update(cx, |v, cx| v.ready(w, cx)) {
            return;
        }
        if self
            .client
            .as_ref()
            .is_some_and(|c| c.command(Command::RefreshSummaries))
        {
            self.state.inventory_refreshing = true;
            self.state.inventory_error = None;
        } else {
            self.state.inventory_error =
                Some("Archive refresh unavailable. Connect to Local to retry.");
        }
        self.archive.update(cx, |v, cx| v.sync(&self.state, w, cx));
        cx.notify();
    }
    pub(super) fn archive_back(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if !self.archive.update(cx, |v, cx| v.ready(w, cx)) {
            return;
        }
        let list = self.archive.read(cx).list.clone();
        if !list.read(cx).query_input().read(cx).value().is_empty() {
            list.update(cx, |l, cx| l.restore_query("", w, cx));
        } else {
            self.move_navigation(false, w, cx);
        }
    }
}
