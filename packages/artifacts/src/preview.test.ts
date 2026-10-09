import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { chromium } from "playwright";
import { closePreviewBrowser, isArtifactPreviewAvailable, previewArtifact } from "./preview.ts";
import { prepareArtifact } from "./render.ts";
import { isSwiftUIPreviewAvailable } from "./swiftui.ts";

const browserInstalled = existsSync(chromium.executablePath());
after(() => closePreviewBrowser());

test("native preview remains available without Chromium", { skip: !isSwiftUIPreviewAvailable() }, (t) => {
	t.mock.method(chromium, "executablePath", () => "/nonexistent/pilot-artifact-chromium");
	assert.equal(isArtifactPreviewAvailable(), true);
});

test("plain images retain natural size and shrink proportionally in inline and expanded viewports", {
	skip: !browserInstalled,
}, async () => {
	const browser = await chromium.launch({ headless: true });
	try {
		const page = await browser.newPage();
		for (const size of [
			{ width: 1, height: 1 },
			{ width: 320, height: 200 },
			{ width: 1600, height: 400 },
			{ width: 400, height: 1600 },
		]) {
			const source = await page.evaluate(({ width, height }) => {
				const canvas = document.createElement("canvas");
				canvas.width = width;
				canvas.height = height;
				return canvas.toDataURL("image/png");
			}, size);
			const prepared = await prepareArtifact({ title: "Image", kind: "image", source });
			await page.setContent(prepared.html);
			await page.locator("img").evaluate((element) => (element as HTMLImageElement).decode());
			for (const viewport of [
				{ width: 640, height: 240 },
				{ width: 1296, height: 810 },
			]) {
				await page.setViewportSize(viewport);
				const image = await page.locator("img").evaluate((element) => {
					const bounds = element.getBoundingClientRect();
					return { width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y };
				});
				const scale = Math.min(1, viewport.width / size.width, viewport.height / size.height);
				assert.ok(Math.abs(image.width - size.width * scale) < 0.1);
				assert.ok(Math.abs(image.height - size.height * scale) < 0.1);
				assert.ok(Math.abs(image.x - (viewport.width - image.width) / 2) < 0.1);
				assert.ok(Math.abs(image.y - (viewport.height - image.height) / 2) < 0.1);
			}
		}
	} finally {
		await browser.close();
	}
});

test("preview validates dimensions and respects cancellation", async () => {
	const source = { title: "test", kind: "html" as const, source: "hello" };
	await assert.rejects(previewArtifact(source, { width: 1 }), /width/);
	await assert.rejects(previewArtifact(source, { signal: AbortSignal.abort() }), /abort/i);
});

test("previews reuse a warm browser with isolated contexts and recover after timeouts", {
	skip: !browserInstalled,
}, async () => {
	const store = { title: "Storage", kind: "html" as const };
	const first = await previewArtifact({
		...store,
		source: "<script>console.log('cookie', document.cookie); document.cookie='leak=1';</script>",
	});
	const started = Date.now();
	const second = await previewArtifact({
		...store,
		source: "<script>console.log('cookie', document.cookie);</script>",
	});
	assert.ok(Date.now() - started < 5000);
	for (const result of [first, second])
		assert.ok(result.consoleMessages.some((message) => message.text === "cookie "));
	await assert.rejects(
		previewArtifact({ ...store, source: "<script>while(true){}</script>" }, { timeoutMs: 1000 }),
		/timed out/,
	);
	const recovered = await previewArtifact({ ...store, source: "<script>console.log('again')</script>" });
	assert.ok(recovered.consoleMessages.some((message) => message.text === "again"));
});

test("preview renders animations and graphs offline and captures runtime diagnostics", {
	skip: !browserInstalled,
}, async () => {
	const source =
		'<div id="graph" style="width:400px;height:260px"></div><script>echarts.init(document.getElementById("graph")).setOption({xAxis:{data:["A","B"]},yAxis:{},series:[{type:"bar",data:[3,5]}]}); console.log("chart ready"); console.error("diagnostic");</script>';
	const result = await previewArtifact({ title: "Chart", kind: "html", source, libraries: ["echarts"] });
	assert.equal(result.screenshot.mimeType, "image/png");
	assert.ok(Buffer.from(result.screenshot.data, "base64").length > 1000);
	assert.ok(result.consoleMessages.some((message) => message.text === "chart ready"));
	assert.ok(result.consoleMessages.some((message) => message.text === "diagnostic"));
	assert.ok(result.contentHeight >= 260);
});

test("preview prevents localhost requests and native/browser access", { skip: !browserInstalled }, async () => {
	let requests = 0;
	const server = createServer((_req, res) => {
		requests++;
		res.end("secret");
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const address = server.address();
		assert.ok(address && typeof address !== "string");
		const target = `http://127.0.0.1:${address.port}`;
		const result = await previewArtifact({
			title: "Sandbox",
			kind: "html",
			source: `<img src="${target}/image"><iframe src="${target}/frame"></iframe><script src="${target}/script"></script><script>fetch(${JSON.stringify(target)}).catch(()=>console.log("blocked"));console.log(typeof process,typeof require);</script>`,
		});
		assert.equal(requests, 0);
		assert.ok(result.consoleMessages.some((message) => message.text === "undefined undefined"));
	} finally {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}
});

test("React interactions and Mermaid diagrams render in the preview", { skip: !browserInstalled }, async () => {
	const react = await previewArtifact({
		title: "React",
		kind: "react",
		source:
			'import {useState} from "react";export default function A(){const [n]=useState(42);console.log("react",n);return <button>{n}</button>}',
	});
	assert.ok(react.consoleMessages.some((message) => message.text === "react 42"));
	assert.ok(!react.consoleMessages.some((message) => message.level === "error"));
	const mermaid = await previewArtifact({
		title: "Diagram",
		kind: "html",
		libraries: ["mermaid"],
		source:
			'<div class="mermaid">graph LR; A-->B</div><script>mermaid.initialize({startOnLoad:false,securityLevel:"strict"});mermaid.run().then(()=>console.log("diagram ready"));</script>',
	});
	assert.ok(mermaid.consoleMessages.some((message) => message.text === "diagram ready"));
	assert.ok(!mermaid.consoleMessages.some((message) => message.level === "error"));
});

test("Mermaid centers in padded pre/div containers at narrow and wide widths, with author overrides", {
	skip: !browserInstalled,
}, async () => {
	for (const width of [320, 1296]) {
		const result = await previewArtifact(
			{
				title: "Centered diagrams",
				kind: "html",
				libraries: ["mermaid"],
				source: `<style>.mermaid{padding:16px;background:#fafafa}.custom > svg{margin-inline:0}</style>
<pre class="mermaid">graph TD; A-->B</pre><div class="mermaid">graph TD; C-->D</div>
<div class="mermaid custom">graph TD; E-->F</div><svg id="other" width="20" height="20"></svg>
<script>mermaid.initialize({startOnLoad:false});mermaid.run().then(()=>{
  for(const host of document.querySelectorAll('.mermaid')){
    const svg=host.querySelector('svg'), box=svg.getBoundingClientRect(), parent=host.getBoundingClientRect();
    console.log(host.classList.contains('custom') ? 'override '+getComputedStyle(svg).marginLeft : 'center '+Math.abs((box.left+box.right-parent.left-parent.right)/2));
  }
  console.log('other '+getComputedStyle(document.getElementById('other')).display);
});</script>`,
			},
			{ width, height: 900 },
		);
		const centered = result.consoleMessages.filter((message) => message.text.startsWith("center "));
		assert.equal(centered.length, 2, JSON.stringify(result.consoleMessages));
		for (const message of centered) assert.ok(Number(message.text.slice(7)) < 1, message.text);
		assert.ok(result.consoleMessages.some((message) => message.text === "override 0px"));
		assert.ok(result.consoleMessages.some((message) => message.text === "other inline"));
	}
});

test("HTML ReactDOM shares React hooks, and optional libraries and animations run locally", {
	skip: !browserInstalled,
}, async () => {
	const result = await previewArtifact({
		title: "Runtime libraries",
		kind: "html",
		libraries: ["react-dom", "motion", "d3", "three"],
		source: `<div id="root"></div><div id="animated" style="opacity:0"></div><script>
function Counter(){const [n]=React.useState(7);console.log("html react",n);return React.createElement("button",null,n);}
ReactDOM.createRoot(document.getElementById("root")).render(React.createElement(Counter));
d3.select("#animated").text("Animated");
motion.animate("#animated", {opacity:1}, {duration:0.05});
const scene = new THREE.Scene(); scene.add(new THREE.Mesh(new THREE.BoxGeometry(),new THREE.MeshBasicMaterial()));
console.log("scene objects",scene.children.length);
setTimeout(()=>console.log("animation",getComputedStyle(document.getElementById("animated")).opacity),150);
</script>`,
	});
	assert.ok(result.consoleMessages.some((message) => message.text === "html react 7"));
	assert.ok(result.consoleMessages.some((message) => message.text === "scene objects 1"));
	assert.ok(result.consoleMessages.some((message) => message.text === "animation 1"));
	assert.ok(
		!result.consoleMessages.some((message) => message.level === "error"),
		JSON.stringify(result.consoleMessages),
	);
});

test("React strings cannot put the HTML script parser in double-escaped mode", {
	skip: !browserInstalled,
}, async () => {
	const result = await previewArtifact({
		title: "HTML text",
		kind: "react",
		source:
			'export default function A(){console.log("mounted html text");console.log(String.raw`<!--<script>`,String.raw`</script>`);return <div>{"<!--<script>"}{"</script>"}</div>}',
	});
	assert.ok(result.consoleMessages.some((message) => message.text === "mounted html text"));
	assert.ok(
		result.consoleMessages.some((message) => message.text === "<!--<script> </script>"),
		JSON.stringify(result.consoleMessages),
	);
	assert.ok(!result.consoleMessages.some((message) => message.level === "error"));
});

test("WebRTC is unavailable and cannot send STUN packets, including through an empty iframe", {
	skip: !browserInstalled,
}, async () => {
	const udp = createSocket("udp4");
	let packets = 0;
	udp.on("message", () => packets++);
	await new Promise<void>((resolve) => udp.bind(0, "127.0.0.1", resolve));
	try {
		const address = udp.address();
		const result = await previewArtifact({
			title: "RTC sandbox",
			kind: "html",
			source: `<script>
function probe(realm,label){
  const Peer = realm.RTCPeerConnection || realm.webkitRTCPeerConnection || realm.mozRTCPeerConnection;
  console.log(label,typeof Peer,typeof realm.WebTransport);
  if(Peer){const peer=new Peer({iceServers:[{urls:'stun:127.0.0.1:${address.port}'}]});peer.createDataChannel('test');peer.createOffer().then(o=>peer.setLocalDescription(o));}
}
probe(window,"main RTC");
try{Object.defineProperty(window,'RTCPeerConnection',{value:()=>{}});}catch(_){console.log("RTC locked");}
const frame=document.createElement('iframe');document.body.appendChild(frame);probe(frame.contentWindow,"iframe RTC");
</script>`,
		});
		assert.equal(packets, 0);
		assert.ok(result.consoleMessages.some((message) => message.text === "main RTC undefined undefined"));
		assert.ok(result.consoleMessages.some((message) => message.text === "RTC locked"));
		assert.ok(
			result.consoleMessages.some((message) => message.text === "iframe RTC undefined undefined"),
			JSON.stringify(result.consoleMessages),
		);
	} finally {
		await new Promise<void>((resolve) => udp.close(() => resolve()));
	}
});
