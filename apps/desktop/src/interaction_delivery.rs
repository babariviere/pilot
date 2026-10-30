//! Sole-writer delivery orchestration. HTTP effects never borrow private Store.
use super::*;

/// The sole private writer services edits while immutable delivery effects wait.
/// Commands stay queued: no second mutation, priority Stop, or checkpoint overtakes delivery.
pub(super) struct DeliveryOwner<'a> {
    pub(super) store: &'a mut Store,
    pub(super) status: &'a mut WriteState,
    pub(super) channels: Option<&'a WorkerChannels>,
    pub(super) autosave: &'a mut Autosave,
    pub(super) closing: &'a mut bool,
}
impl DeliveryOwner<'_> {
    fn prepared(&mut self, notice: &'static str) {
        self.status.book = Some(Arc::new(self.store.book.clone()));
        self.status.notice = notice;
        if let Some(channels) = self.channels {
            publish(&channels.updates, &channels.replace, self.status.clone());
        }
    }

    fn save(&mut self) -> Result<(), Failure> {
        let Some(channels) = self.channels else {
            return if self.store.is_faulted() {
                Err(
                    "Private writer is fenced after an I/O failure. Keep/copy unsaved text before restart.",
                )
            } else {
                Ok(())
            };
        };
        *self.autosave = Autosave::default();
        if channels.edits.lock().is_ok_and(|edits| !edits.is_empty()) {
            self.status.checkpoint = None;
        }
        let result = flush(self.store, &channels.edits);
        self.status.error = result.err();
        self.status.book = Some(Arc::new(self.store.book.clone()));
        publish(&channels.updates, &channels.replace, self.status.clone());
        result
    }

    /// The future cannot borrow Store. Close drops it, leaving admitted intent Unknown.
    pub(super) async fn effect<T>(
        &mut self,
        effect: impl std::future::Future<Output = Result<T, Failure>>,
    ) -> Result<T, Failure> {
        let Some(channels) = self.channels else {
            return effect.await;
        };
        tokio::pin!(effect);
        loop {
            tokio::select! {
                biased;
                _ = channels.close.recv() => {
                    *self.closing = true;
                    return Err("Closing. Any interrupted delivery remains unconfirmed.");
                },
                result = &mut effect => return result,
                _ = tokio::time::sleep_until(self.autosave.deadline.unwrap_or_else(|| tokio::time::Instant::now() + Duration::from_secs(3600))),
                    if self.autosave.deadline.is_some() => {
                    // Retain failed edits in the mailbox. An already-dispatched request
                    // must still be observed, particularly an exact accepted ACK.
                    let _ = self.save();
                },
                signal = channels.wake.recv() => {
                    if signal.is_err() {
                        *self.closing = true;
                        return Err("Closing. Any interrupted delivery remains unconfirmed.");
                    }
                    self.autosave.edited(tokio::time::Instant::now());
                }
            }
        }
    }

    /// Conversion keeps its staged one-shot intent; only draft edits overlap HTTP.
    pub(super) async fn mission(
        &mut self,
        client: &reqwest::Client,
        options: &LocalOptions,
        target: &crate::mission_conversion::Target,
        action: crate::mission_conversion::Action,
    ) -> Result<crate::mission_conversion::Inspection, Failure> {
        use crate::{
            mission_conversion::{Action, Inspection},
            mission_transport,
        };
        match action {
            Action::Inspect if !self.store.book.missions.contains_key(&target.source) => {
                Ok(Inspection::Ready {
                    title: self
                        .effect(mission_transport::admit(client, options, target))
                        .await?,
                })
            }
            Action::Inspect | Action::Check => {
                self.effect(mission_transport::observe(client, options, target))
                    .await
            }
            Action::Submit { id, request } => {
                request.validate()?;
                if request.from_session_id != target.source || request.project_id != target.project
                {
                    return Err("Captured mission source changed");
                }
                self.effect(mission_transport::admit(client, options, target))
                    .await?;
                let attempt = self.store.prepare_mission(&id, request)?;
                self.prepared(self.status.notice);
                let result = self
                    .effect(mission_transport::submit_request(
                        client, options, target, &attempt,
                    ))
                    .await?;
                if let Inspection::Created { mission_id } = &result {
                    return mission_transport::retain_receipt(self.store, target, &id, mission_id);
                }
                Ok(result)
            }
        }
    }

    /// Model selection uses the same FIFO writer and edit mailbox as delivery.
    pub(super) async fn model(
        &mut self,
        client: &reqwest::Client,
        options: &LocalOptions,
        action: crate::chat_models::Action,
    ) -> Result<crate::chat_models::Outcome, Failure> {
        use crate::chat_models::{self, Action, Outcome};
        match action {
            Action::Submit(attempt) => {
                match self
                    .effect(chat_models::submit_preflight(client, options, &attempt))
                    .await
                {
                    Err(error) if *self.closing => return Err(error),
                    Err(error) => return Ok(Outcome::Refused(error)),
                    Ok(()) => {}
                }
                // New edits do not replace the captured choice/target or any Pending.
                if let Err(error) = self.store.prepare_model_change(attempt.clone()) {
                    return Ok(Outcome::Refused(error));
                }
                self.prepared(self.status.notice);
                let outcome = self
                    .effect(async {
                        Ok(chat_models::submit_request(client, options, &attempt).await)
                    })
                    .await?;
                if matches!(outcome, Outcome::Acknowledged(_)) {
                    // Preserve the exact accepted ACK in memory even on cleanup failure.
                    let _ = self
                        .store
                        .finish_model_change(&attempt.target.session, &attempt.id);
                }
                Ok(outcome)
            }
            Action::Inspect(target) => {
                let result = self
                    .effect(chat_models::session(client, options, &target))
                    .await;
                if *self.closing {
                    return Err("Closing. Model inspection was interrupted.");
                }
                Ok(match result {
                    Ok(current) => Outcome::Observed(current),
                    Err(error) => Outcome::Refused(error),
                })
            }
            Action::Acknowledge { session, id } => {
                let Some(attempt) = self
                    .store
                    .book
                    .model_changes
                    .get(&session)
                    .filter(|a| a.id == id)
                else {
                    return Ok(Outcome::Refused(
                        "Model switch ownership changed. Nothing was acknowledged.",
                    ));
                };
                let target = attempt.target.clone();
                let result = self
                    .effect(chat_models::session(client, options, &target))
                    .await;
                if *self.closing {
                    return Err("Closing. Model inspection was interrupted.");
                }
                Ok(match result {
                    Ok(current) => match self.store.finish_model_change(&session, &id) {
                        Ok(()) => Outcome::Dismissed(current),
                        Err(error) => Outcome::Refused(error),
                    },
                    Err(error) => Outcome::Refused(error),
                })
            }
            Action::Force { target, force } => {
                self.effect(async { Ok(chat_models::force(client, options, &target, force).await) })
                    .await
            }
            Action::Continue(attempt) => {
                match self
                    .effect(chat_models::continue_preflight(client, options, &attempt))
                    .await
                {
                    Err(error) if *self.closing => return Err(error),
                    Err(error) => return Ok(Outcome::Refused(error)),
                    Ok(()) => {}
                }
                if let Err(error) = self.store.prepare_model_change(attempt.clone()) {
                    return Ok(Outcome::Refused(error));
                }
                self.prepared(self.status.notice);
                let outcome = self
                    .effect(async {
                        Ok(chat_models::continue_request(client, options, &attempt).await)
                    })
                    .await?;
                // Only the existing definitive outcomes settle continuation. GET/echo
                // never proves success; a known ACK survives a private disk fault.
                if matches!(
                    outcome,
                    Outcome::Refused(_) | Outcome::Acknowledged(_) | Outcome::Continued(_)
                ) {
                    let _ = self
                        .store
                        .finish_model_change(&attempt.target.session, &attempt.id);
                }
                Ok(outcome)
            }
        }
    }

    pub(super) async fn submit(
        &mut self,
        client: &reqwest::Client,
        options: &LocalOptions,
        request: Submission<'_>,
        report: &mut Option<DeliveryReport>,
    ) -> Result<&'static str, Failure> {
        let model_pending = request
            .key
            .strip_prefix("chat:")
            .is_some_and(|target| self.store.book.model_changes.contains_key(target));
        self.effect(send_preflight(
            client,
            options,
            &request,
            model_pending,
            false,
        ))
        .await?;
        // Preflight may have overlapped newer input. Save it without replacing the
        // captured request. Store::prepare reserves that exact older intent.
        self.save()?;
        if self.store.book.host != options.host() {
            return Err("Local identity changed. Draft retained.");
        }
        let intent =
            self.store
                .prepare(request.key, request.draft, request.follow_up, request.stop)?;
        ensure_owned(self.store, options, &intent)?;
        self.prepared("Intent saved. Waiting for Local delivery.");
        if request.stop {
            // Stop has no durable operation/receipt API. Never retry it automatically.
            // Keep transport failure Unknown; only owner cancellation exits the effect.
            let result = self
                .effect(async {
                    Ok(read_stop_json(
                        client
                            .post(format!(
                                "{}/api/sessions/{}/stop",
                                options.loopback(),
                                intent.target
                            ))
                            .header("Content-Type", "application/json")
                            .body("{}"),
                    )
                    .await)
                })
                .await?;
            match result {
                Ok(value)
                    if value["ok"] == true
                        && (value["draft"].is_null() || value["draft"].is_string()) =>
                {
                    self.store.finish(
                        &intent.id,
                        "accepted",
                        value["draft"].as_str().map(String::from),
                    )?;
                    Ok("Stop accepted. Any withdrawn queued text is retained separately.")
                }
                _ => Ok(
                    "Stop outcome is unknown. It was not retried. Inspect the chat before another action.",
                ),
            }
        } else if let Some(target) = crate::session_subagents::Target::from_key(request.key) {
            // Preserve the captured child/generation and one-shot request bytes.
            // The future owns no Store borrow, so only draft edits can overlap it.
            self.effect(subagent_request(client, options, &target, &intent, report))
                .await?;
            self.store.finish(&intent.id, "accepted", None)?;
            Ok("")
        } else {
            self.reconcile(client, options, &intent.id, true, None, report)
                .await
        }
    }

    pub(super) async fn reconcile(
        &mut self,
        client: &reqwest::Client,
        options: &LocalOptions,
        id: &str,
        retry: bool,
        question: Option<&crate::question::Question>,
        report: &mut Option<DeliveryReport>,
    ) -> Result<&'static str, Failure> {
        let previous = report.take();
        let Some(intent) = self.store.book.pending.get(id).cloned() else {
            return Ok("Delivery already settled.");
        };
        let Some(op) = &intent.operation else {
            return Ok("Stop has no receipt API. Its uncertainty cannot be safely retried.");
        };
        if op.kind == "subagent-send" {
            if previous
                .as_ref()
                .and_then(|r| r.delivery.diagnostic)
                .is_some_and(|d| d.acknowledgment == Acknowledgment::Accepted)
            {
                *report = previous;
                self.store.finish(id, "accepted", None)?;
                return Ok("");
            }
            *report = previous;
            return Ok(
                "Subagent messages have no receipt lookup. This uncertain message was not retried.",
            );
        }
        *report = Some(DeliveryReport::new(&intent, previous.as_ref()));
        let diagnostic = report
            .as_mut()
            .unwrap()
            .delivery
            .diagnostic
            .as_mut()
            .unwrap();
        self.effect(verify_local(client, options, diagnostic))
            .await?;
        let mut receipt = self
            .effect(operation(client, options, op, true, diagnostic))
            .await?;
        if receipt["state"] == "unknown" && retry {
            // Explicit Retry retains the same envelope/target. Pending is NEVER re-posted.
            if op.kind == "chat-send" {
                if !crate::delivery_store::token(&op.target_id) {
                    return Err("Invalid Local chat target");
                }
                let summary = self
                    .effect(observe(
                        options,
                        diagnostic,
                        Stage::Target,
                        client.get(format!(
                            "{}/api/sessions/{}",
                            options.loopback(),
                            op.target_id
                        )),
                    ))
                    .await?;
                writable_summary(&summary, &op.target_id)
                    .inspect_err(|_| diagnostic.category = Category::Refused)?;
                if let Some(answer) = &intent.answer {
                    if let Some(question) = question {
                        self.store
                            .book
                            .drafts
                            .get(&intent.key)
                            .and_then(|d| d.answer.as_ref())
                            .filter(|a| a.identity == *answer)
                            .ok_or("Question reply ownership changed; original reply retained")?
                            .reply(question)
                            .inspect_err(|_| diagnostic.category = Category::Refused)?;
                    }
                    let awaited = question
                        .is_some_and(|q| q.identity == answer.question && q.content.blocking);
                    question_turn_ready(&summary, awaited)
                        .inspect_err(|_| diagnostic.category = Category::Refused)?;
                }
            }
            self.effect(verify_local(client, options, diagnostic))
                .await?;
            // Do not dispatch after a failed autosave or an ownership change.
            self.save()
                .and_then(|()| ensure_owned(self.store, options, &intent))
                .inspect_err(|error| adoption_failure(diagnostic, self.store, error))?;
            receipt = self
                .effect(operation(client, options, op, false, diagnostic))
                .await?;
        }
        adopt_receipt(self.store, options, &intent, &receipt, diagnostic)
    }

    pub(super) async fn submit_answer(
        &mut self,
        client: &reqwest::Client,
        options: &LocalOptions,
        request: AnswerSubmission<'_>,
        report: &mut Option<DeliveryReport>,
    ) -> Result<&'static str, Failure> {
        let AnswerSubmission {
            key,
            draft,
            question,
        } = request;
        let target = key
            .strip_prefix("chat:")
            .ok_or("Question replies require an existing Local chat")?;
        let answer = draft
            .answer
            .as_ref()
            .ok_or("Question reply capture is missing")?;
        if answer.reply(question)?.is_none() {
            return Err("Choose an answer or write a reply");
        }
        self.effect(gate(client, options)).await?;
        if self.store.book.model_changes.contains_key(target) {
            return Err("A model switch is unconfirmed. Question reply retained");
        }
        question_turn_ready(
            &self.effect(writable(client, options, target)).await?,
            question.content.blocking,
        )?;
        // The native owner has checked its exact current question projection.
        // Local only offers ordinary steering, not an atomic question-CAS endpoint.
        // Preflight may overlap a newer answer or ordinary edit. Persist first;
        // prepare_answer retains its existing stale-capture and selection fences.
        self.save()?;
        if self.store.book.host != options.host() {
            return Err("Local identity changed. Question reply retained.");
        }
        let intent = self.store.prepare_answer(key, draft, question, answer)?;
        ensure_owned(self.store, options, &intent)?;
        self.prepared("Reply saved. Sending…");
        self.reconcile(client, options, &intent.id, true, Some(question), report)
            .await
    }
}
