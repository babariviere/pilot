/**
 * Kinds of Pilot entries saved in chat transcripts. Saved history and readers outside the kernel (pilotd, Day's
 * Rust session_chat.rs) match these exact strings, so never rename one. This module loads no tool or SDK runtime.
 */
export const QUESTION_ENTRY = "pilot.question";
export const ACTIVITY_ENTRY = "pilot.activity";
export const INTERVIEW_SUBMISSION_ENTRY = "pilot.interview-submission";
export const PLANNING_INPUT_ENTRY = "pilot.planning-input";
