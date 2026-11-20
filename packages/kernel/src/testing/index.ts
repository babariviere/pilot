/** Durable fixtures for other packages' tests. Loads no native runtime. */
export { AttentionDoc } from "../tools/attention/attention.ts";
export { HeldInputsDoc } from "../session/input/held-inputs-doc.ts";
export { decisionNotice } from "../missions/mission-decisions.ts";
export { missionPrompt } from "../runtime/policy.ts";
export { QuestionClarifications } from "../tools/questions/question-clarifications.ts";
export { openSessionStorage } from "../history/storage.ts";
export { TodoProgressDoc } from "../tools/todos/todos.ts";

/** Faux Day Insights kernel worker. Fork it with "advanced" serialization. */
export const dayInsightsFauxWorkerEntry = new URL("./day-insights-faux-worker.ts", import.meta.url);
