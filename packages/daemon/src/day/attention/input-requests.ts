/**
 * Request IDs that pilotd mints for automatic input. They are stored in pending outboxes, kernel submissions and
 * schedule runs, so every prefix and format here is stored data: never change one. The kernel maps some prefixes to
 * a transcript origin (packages/kernel/src/session/input/input-origin.ts).
 */

/** `schedule:<id>` or `schedule:<id>:<due>`. The kernel shows schedule input as the user's own message. */
export function scheduleRequestId(scheduleId: string, due?: number): string {
	return `schedule:${scheduleId}${due === undefined ? "" : `:${due}`}`;
}

export function parseScheduleRequestId(requestId: string): { scheduleId: string; due?: number } | undefined {
	const parts = /^schedule:([^:]+)(?::(\d+))?$/.exec(requestId);
	if (!parts) return undefined;
	return { scheduleId: parts[1]!, ...(parts[2] === undefined ? {} : { due: Number(parts[2]) }) };
}

export const isScheduleRequest = (requestId: string): boolean => requestId.startsWith("schedule:");

export const slackReplyRequestId = (itemId: string, latest: string): string => `slack-reply:${itemId}:${latest}`;
export const isSlackReply = (requestId: string): boolean => requestId.startsWith("slack-reply:");

export const flowInputId = (rootId: string, round: number, node: number): string =>
	`automation:flow:${rootId}:${round}:${node}`;
export const isFlowInput = (requestId: string): boolean => requestId.startsWith("automation:flow:");

/** Post-run follow-ups. Flow input shares the `automation:` prefix and is not one of them. */
export const automationRequestId = (triggerId: string): string => `automation:${triggerId}`;
export const isAutomationRequest = (requestId: string): boolean =>
	requestId.startsWith("automation:") && !isFlowInput(requestId);

const INSIGHTS_REVIEW_PREFIX = "insights-review:";
export const insightsReviewRequestId = (runId: string): string => INSIGHTS_REVIEW_PREFIX + runId;
export const isInsightsReview = (requestId: string): boolean => requestId.startsWith(INSIGHTS_REVIEW_PREFIX);
export const insightsReviewRunId = (requestId: string): string | undefined =>
	isInsightsReview(requestId) ? requestId.slice(INSIGHTS_REVIEW_PREFIX.length) : undefined;

export const workspaceSetupRequestId = (triggerId: string): string => `workspace-setup:${triggerId}`;
export const isWorkspaceSetup = (requestId: string): boolean => requestId.startsWith("workspace-setup:");

export const missionNoticeRequestId = (lastEventId: number): string => `mission-notice:${lastEventId}`;
export const isMissionNotice = (requestId: string): boolean => requestId.startsWith("mission-notice:");

/** One reminder per user input: the ID names the chat and its last input, so the kernel never takes it twice. */
export const missionWaitRequestId = (sessionId: string, lastInputAt: number): string =>
	`mission-wait:${sessionId}:${lastInputAt}`;
export const isMissionWait = (requestId: string): boolean => requestId.startsWith("mission-wait:");

export const piReloadRequestId = (nonce: string): string => `piReload:${nonce}`;
export const isPiReload = (requestId: string): boolean => requestId.startsWith("piReload:");

const JOBS_INSPECTION_PREFIX = "inspectJobs:";
export const jobsInspectionRequestId = (nonce: string): string => JOBS_INSPECTION_PREFIX + nonce;
export const isJobsInspection = (requestId: string): boolean => requestId.startsWith(JOBS_INSPECTION_PREFIX);
