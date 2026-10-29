/** Isolated synthetic worker. The parent kills it only after the question is durable. */
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import {
	fauxAssistantMessage,
	fauxProvider,
	fauxToolCall,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	Type,
} from "@earendil-works/pi-ai";
import { createCodemodeExtension, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { HeldInputsDoc } from "../held-inputs.ts";
import { NativeAdapter } from "../native-adapter.ts";
import { KernelSession } from "../session.ts";

const root = process.argv[2]!;
const runtime = await ModelRuntime.create({
	credentials: new InMemoryCredentialStore(),
	modelsPath: null,
	modelsStore: new InMemoryModelsStore(),
	allowModelNetwork: false,
	refreshOnCreate: false,
});
const faux = fauxProvider({ provider: "pilot-question-test", models: [{ id: "offline" }] });
runtime.registerNativeProvider(faux.provider);
const open = NativeAdapter.open;
NativeAdapter.open = (options) =>
	open.call(NativeAdapter, {
		...options,
		projectTrusted: false,
		agentDir: join(root, "agent"),
		settingsManager: SettingsManager.inMemory({ defaultTools: ["codemode"] }),
		sessionOptions: {
			...options.sessionOptions,
			modelRuntime: runtime,
			model: faux.getModel(),
			customTools: [
				...(options.sessionOptions?.customTools ?? []),
				{
					name: "question_wait",
					label: "Wait",
					description: "Synthetic post-answer gate",
					parameters: Type.Object({}),
					execute: async () => {
						process.send?.("resumed");
						await new Promise(() => {});
						return { content: [], details: {} };
					},
				},
				{
					name: "question_effect",
					label: "Effect",
					description: "Synthetic effect",
					parameters: Type.Object({ value: Type.String() }),
					execute: async (_id, args) => {
						const value = (args as { value: string }).value;
						await appendFile(join(root, "effects"), `${value}\n`);
						return { content: [{ type: "text", text: value }], details: {} };
					},
				},
			],
		},
		loaderOptions: {
			cwd: root,
			agentDir: join(root, "agent"),
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: [createCodemodeExtension({ models: false, mode: "on" })],
		},
	});
faux.setResponses([
	fauxAssistantMessage(
		fauxToolCall("codemode", {
			code: 'await tools.question_effect({value:"before"}); await tools.ask_user({question:"Continue?"}); await tools.question_wait({}); await tools.question_effect({value:"after"});',
		}),
		{ stopReason: "toolUse" },
	),
]);
const session = await KernelSession.open(
	{ sessionId: "crashed-question", cwd: root, storageDir: join(root, "storage") },
	{ onWorking: () => {} },
);
const watch = await session.harness.watchDoc(HeldInputsDoc, session.conversation.id, context);
watch!.start(async (value) => {
	if (value?.questionPending) process.send?.("waiting");
});
await session.submit("ask", "Ask", "followUp");
process.on("message", (message) => {
	if (message === "answer") void session.submit("answer", "Continue", "steer").then(() => process.send?.("accepted"));
});
