//! The workflow confirmation sheet, owned by LocalViewer. Mission Overview only asks to open
//! it; the private writer and its retained attempts live here.
use super::*;
use crate::workflow_confirmation::Purpose;
use crate::workflow_confirmation_view::{Event as WorkflowEvent, Sheet, Target};
use gpui_kit::component::WindowExt as _;

impl LocalViewer {
    /// Open the sheet for this exact mission and purpose. The coordinator title is display only.
    pub(crate) fn open_workflow(
        &mut self,
        mut target: Target,
        purpose: Purpose,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.editor.update(cx, |e, cx| e.marked(w, cx)) {
            return;
        }
        let Some(options) = self.usage_options.clone() else {
            return;
        };
        if let Some((id, title)) = target.coordinator.as_mut()
            && let Some(chat) = self.state.chats.iter().find(|c| &c.id == id)
        {
            *title = chat.title.clone();
        }
        let sheet = match &self.workflow {
            Some((s, _)) if s.read(cx).matches(&target, purpose, &options) => s.clone(),
            _ => {
                self.close_workflow(w, cx);
                let sheet = cx.new(|cx| Sheet::new(target, purpose, options, cx));
                let events = cx.subscribe_in(&sheet, w, |v, sheet, event, w, cx| {
                    v.workflow_event(sheet, event, w, cx)
                });
                self.workflow = Some((sheet.clone(), events));
                sheet
            }
        };
        let (book, reply) = (self.insights_book.clone(), self.workflow_reply.clone());
        // Retained attempts first: an open confirmation is shown from its own bytes, not re-read.
        sheet.update(cx, |s, cx| {
            s.visible = true;
            s.accept(book.as_ref(), reply.as_ref(), cx);
            s.refresh(cx);
        });
        self.workflow_return = w.focused(cx);
        Sheet::open(sheet, w, cx);
    }

    fn workflow_event(
        &mut self,
        sheet: &Entity<Sheet>,
        event: &WorkflowEvent,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.workflow.as_ref().is_none_or(|(s, _)| s != sheet) {
            return;
        }
        match event {
            WorkflowEvent::Close => self.close_workflow(w, cx),
            WorkflowEvent::Write { request, action } => {
                let sent = self.writer.as_ref().is_some_and(|writer| {
                    writer.command(crate::interaction::WriteCommand::Workflow {
                        request: *request,
                        action: action.clone(),
                    })
                });
                if !sent {
                    sheet.update(cx, |s, cx| s.not_sent(cx));
                }
            }
        }
    }

    pub(crate) fn close_workflow(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let Some((sheet, _)) = &self.workflow else {
            return;
        };
        let sheet = sheet.clone();
        if !sheet.read(cx).visible {
            return;
        }
        let owned = sheet.read(cx).owns_focus(w, cx);
        w.close_dialog(cx);
        sheet.update(cx, |s, cx| {
            s.visible = false;
            cx.notify();
        });
        if owned && let Some(focus) = self.workflow_return.take() {
            focus.focus(w, cx);
        }
    }
}
