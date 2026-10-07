import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createSocket } from "node:dgram";
import { createServer } from "node:http";
import { test } from "node:test";
import { chromium } from "playwright";
import { previewArtifact } from "./preview.ts";

const browserInstalled = existsSync(chromium.executablePath());

test("preview validates dimensions and respects cancellation", async () => {
	const source = { title: "test", kind: "html" as const, source: "hello" };
	await assert.rejects(previewArtifact(source, { width: 1 }), /width/);
	await assert.rejects(previewArtifact(source, { signal: AbortSignal.abort() }), /abort/i);
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
