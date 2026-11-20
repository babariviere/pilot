import assert from "node:assert/strict";
import { test } from "node:test";
import { inputOrigin } from "@pilot/kernel";
import {
	automationRequestId,
	flowInputId,
	insightsReviewRequestId,
	insightsReviewRunId,
	isAutomationRequest,
	isFlowInput,
	isJobsInspection,
	isScheduleRequest,
	jobsInspectionRequestId,
	missionNoticeRequestId,
	missionWaitRequestId,
	parseScheduleRequestId,
	piReloadRequestId,
	scheduleRequestId,
	slackReplyRequestId,
	workspaceSetupRequestId,
} from "./input-requests.ts";

test("schedule admission keeps the saved ID format and user transcript origin", () => {
	assert.equal(scheduleRequestId("rule"), "schedule:rule");
	assert.equal(scheduleRequestId("rule", 0), "schedule:rule:0");
	assert.equal(scheduleRequestId("rule", 1730000000000), "schedule:rule:1730000000000");
	assert.deepEqual(parseScheduleRequestId("schedule:rule"), { scheduleId: "rule" });
	assert.deepEqual(parseScheduleRequestId("schedule:rule:0"), { scheduleId: "rule", due: 0 });
	assert.equal(parseScheduleRequestId("schedule:rule:later"), undefined);
	assert.equal(isScheduleRequest("schedule:rule:later"), true, "admission still sees malformed schedule IDs");
	assert.equal(inputOrigin("schedule:rule:0"), undefined);
});

test("automatic inputs keep their saved IDs and transcript origins", () => {
	const flow = flowInputId("root", 3, 2);
	assert.equal(flow, "automation:flow:root:3:2");
	assert.equal(isFlowInput(flow), true);
	assert.equal(isAutomationRequest(flow), false);
	assert.equal(isAutomationRequest(automationRequestId("trigger")), true);
	assert.equal(inputOrigin(flow), "automation");
	assert.equal(automationRequestId("trigger"), "automation:trigger");
	assert.equal(workspaceSetupRequestId("trigger"), "workspace-setup:trigger");
	assert.equal(slackReplyRequestId("item", "123.456"), "slack-reply:item:123.456");
	assert.equal(missionNoticeRequestId(7), "mission-notice:7");
	assert.equal(missionWaitRequestId("chat", 1730000000000), "mission-wait:chat:1730000000000");
	assert.equal(insightsReviewRequestId("run:1"), "insights-review:run:1");
	assert.equal(insightsReviewRunId("insights-review:run:1"), "run:1");
	assert.equal(insightsReviewRunId("schedule:rule"), undefined);
	assert.equal(piReloadRequestId("nonce"), "piReload:nonce");
	assert.equal(jobsInspectionRequestId("nonce"), "inspectJobs:nonce");
	assert.equal(isJobsInspection("inspectJobs:nonce"), true);
});
