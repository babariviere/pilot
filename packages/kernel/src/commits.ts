import type { CommitObserver, Session } from "@earendil-works/pi-durable";

/** Observe stored commits; detach with the returned disposer. */
export function observeCommits(session: Session, advance: CommitObserver["advance"]): () => void {
	const observation = session.observeCommits({ advance, end() {} });
	return () => observation.detach();
}
