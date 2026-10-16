/** Disposable CI only. Helpers have no production setup or credential authority. */
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";

export const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRisAAAAASUVORK5CYII=";
export function operation(hello, payload, { kind = "chat-create", targetId = randomUUID() } = {}) {
	const bytes = JSON.stringify(payload);
	return {
		schemaVersion: 1,
		operationId: randomUUID(),
		producerId: randomUUID(),
		sequence: 1,
		origin: { hostId: "fixture", daemonId: "fixture", lineageId: "fixture" },
		destination: { hostId: "devbox", daemonId: hello.daemonId, lineageId: hello.lineageId },
		kind,
		targetId,
		payload: bytes,
		payloadHash: hash(bytes),
	};
}
export async function child(command, args, input, { timeoutMs = 30_000, maximumBytes = 128 * 1024 } = {}) {
	return new Promise((resolve, reject) => {
		const proc = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
		const output = [];
		let bytes = 0;
		const timer = setTimeout(() => {
			proc.kill("SIGKILL");
			reject(new Error("Fixture child deadline"));
		}, timeoutMs);
		proc.stdout.on("data", (data) => {
			bytes += data.length;
			if (bytes > maximumBytes) {
				proc.kill("SIGKILL");
				reject(new Error("Fixture child output limit"));
			} else output.push(data);
		});
		// SSH diagnostics can contain sensitive material in real environments. Fixtures report only exit status.
		proc.stderr.resume();
		proc.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		proc.on("close", (code) => {
			clearTimeout(timer);
			code === 0 ? resolve(Buffer.concat(output).toString()) : reject(new Error(`Fixture child exit ${code}`));
		});
		proc.stdin.on("error", () => {});
		proc.stdin.end(input);
	});
}
export async function until(check, label, timeoutMs = 60_000) {
	const end = Date.now() + timeoutMs;
	while (!(await check())) {
		if (Date.now() >= end) throw new Error(`Packaged workflow deadline: ${label}`);
		await delay(100);
	}
}
export async function freePort() {
	const server = createServer().listen(0, "127.0.0.1");
	await once(server, "listening");
	const port = server.address().port;
	await new Promise((resolve) => server.close(resolve));
	return port;
}
export async function api(base, path, { method = "GET", body, headers = {}, maximumBytes = 2 * 1024 * 1024 } = {}) {
	const response = await fetch(new URL(`/api/${path}`, base), {
		method,
		body: body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body),
		headers: { "content-type": "application/json", ...headers },
		signal: AbortSignal.timeout(10_000),
	});
	const chunks = [];
	let bytes = 0;
	for await (const chunk of response.body) {
		bytes += chunk.length;
		if (bytes > maximumBytes) throw new Error("Fixture HTTP response limit");
		chunks.push(chunk);
	}
	if (!response.ok) throw new Error(`Fixture HTTP ${response.status}: ${path.split("?")[0]}`);
	return JSON.parse(Buffer.concat(chunks).toString());
}

/** Resolves the bundled faux provider on the target, never a developer's source dependencies. */
export function setupSource(home) {
	return `
import { mkdir, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
const home = ${JSON.stringify(home)}, repo = home + '/workflow-repo', agent = home + '/.pi/agent';
await mkdir(repo, {recursive:true}); await mkdir(agent, {recursive:true, mode:0o700});
await writeFile(repo + '/tracked.txt', 'before\\n');
for (const args of [['init','-b','main'], ['add','tracked.txt'], ['-c','user.name=Fixture','-c','user.email=fixture@example.invalid','commit','-m','fixture']]) execFileSync('git',args,{cwd:repo,stdio:'ignore'});
const faux = import.meta.resolve('@earendil-works/pi-ai/providers/faux');
const command = 'printf started > started; while [ ! -f release ]; do sleep 0.05; done; printf remote-workflow-ok > tracked.txt; printf complete > completed';
const code = 'await tools.bash({command:' + JSON.stringify(command) + '});' +
 'await tools.artifact({action:"create",kind:"html",title:"Packaged HTML",source:"<p>remote-html-ok</p>"});' +
 'await tools.artifact({action:"create",kind:"react",title:"Packaged React",source:"export default function View(){return <p>remote-react-ok</p>}"});' +
 'await tools.artifact({action:"create",kind:"image",title:"Packaged image",source:"data:image/png;base64,${png}"});' +
 'return "packaged-tool-complete";';
const extension = 'import {fauxProvider,fauxAssistantMessage} from ' + JSON.stringify(faux) + ';\\n' +
 'export default pi => { const faux=fauxProvider(); faux.setResponses([' +
 'fauxAssistantMessage({type:"toolCall",id:"packaged-tool",name:"codemode",arguments:{code:' + JSON.stringify(code) + '}},{stopReason:"toolUse"}),' +
 'fauxAssistantMessage("Packaged workflow complete")]); pi.registerProvider(faux.provider); };';
await writeFile(agent + '/workflow.ts', extension, {mode:0o600});
await writeFile(agent + '/settings.json', JSON.stringify({extensions:[agent+'/workflow.ts'],defaultProvider:'faux',defaultModel:'faux-1',defaultTools:['+codemode'],codemode:{mode:'only'}}),{mode:0o600});
console.log(JSON.stringify({repo}));
`;
}
