/** Durable fixtures for other packages' tests. Loads no native runtime. */
export { AttentionDoc } from "../attention.ts";
export { HeldInputsDoc } from "../held-inputs-doc.ts";
export { decisionNotice } from "../mission-decisions.ts";
export { missionPrompt } from "../policy.ts";
export { QuestionClarifications } from "../question-clarifications.ts";
export { openSessionStorage } from "../storage.ts";
export { TodoProgressDoc } from "../todos.ts";

/** Faux Day Insights kernel worker. Fork it with "advanced" serialization. */
export const dayInsightsFauxWorkerEntry = new URL("./day-insights-faux-worker.ts", import.meta.url);
