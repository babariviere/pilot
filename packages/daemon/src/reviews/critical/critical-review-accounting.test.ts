import assert from "node:assert/strict";
import { test } from "node:test";
import { openGates, reviewFixture } from "./critical-review.test-fixture.ts";
import { REVIEW_PROFILES } from "./critical-review-accounting.ts";

test("durable reservation before send, no replay, crash retains worst-case usage", async () => {
	const f = await reviewFixture();
	try {
		await f.run("run", "low");
		await f.accounting.admit("run", "run-approval", "low", openGates);
		const receipt = await f.accounting.reserve(f.request("run", "call", { inputTokens: 30_000 }));
		assert.equal((await f.store.get("reservation", "call"))!.reserved.inputTokens, 30_000);
		await assert.rejects(f.accounting.send("call", { ...openGates, subscriptionPaused: true }), /gate/);
		await f.accounting.send("call", openGates);
		await f.restart();
		await assert.rejects(f.accounting.send("call", openGates), /replay/);
		await f.accounting.admit("run", "run-approval", "low", openGates);
		await assert.rejects(f.accounting.reserve(f.request("run", "next", { inputTokens: 3000 })), /inputTokens/);
		await assert.rejects(f.accounting.reserve(f.request("run", "call")), /already reserved/);
		await f.accounting.settle("call", { inputTokens: 1000, generatedTokens: 100, durationMs: 100 });
		await f.accounting.settle("call", { inputTokens: 1000, generatedTokens: 100, durationMs: 100 });
		await assert.rejects(
			f.accounting.settle("call", { inputTokens: 0, generatedTokens: 0, durationMs: 0 }),
			/conflict/,
		);
		assert.equal(receipt.reserved.inputTokens, 30_000);
		await f.accounting.reserve(f.request("run", "next", { inputTokens: 3000 }));
	} finally {
		await f.close();
	}
});

test("concurrent host/target admission and reserve races have one bounded winner", async () => {
	const f = await reviewFixture();
	try {
		await f.run("a", "medium", "shared");
		await f.run("b", "medium", "shared");
		await f.run("c");
		await f.run("d");
		const outcomes = await Promise.allSettled(
			["a", "b"].map((id) => f.accounting.admit(id, `${id}-approval`, "medium", openGates)),
		);
		assert.equal(outcomes.filter((x) => x.status === "fulfilled").length, 1);
		const winner = outcomes[0]!.status === "fulfilled" ? "a" : "b";
		await f.accounting.admit("c", "c-approval", "medium", openGates);
		await assert.rejects(f.accounting.admit("d", "d-approval", "medium", openGates), /concurrency/);
		const reserved = await Promise.allSettled([
			f.accounting.reserve(f.request(winner, "one")),
			f.accounting.reserve(f.request(winner, "two")),
		]);
		assert.equal(reserved.filter((x) => x.status === "fulfilled").length, 1);
	} finally {
		await f.close();
	}
});

test("verified pricing, explicit grants, subscription pause and no paid fallback", async () => {
	const f = await reviewFixture();
	try {
		await f.run("run");
		await assert.rejects(f.accounting.admit("run", "forged", "medium", openGates), /unavailable/);
		await assert.rejects(f.accounting.verifyRate({ ...f.rate, id: "unverified", validUntil: 0 }), /pricing/);
		await f.accounting.admit("run", "run-approval", "medium", openGates);
		await assert.rejects(f.accounting.reserve(f.request("run", "missing", { rateId: "missing" })), /pricing/);
		await f.accounting.verifyRate({ ...f.rate, id: "other", modelId: "other" });
		await assert.rejects(f.accounting.reserve(f.request("run", "other", { rateId: "other" })), /fallback/);
		await f.accounting.finish("run");
		const { approval } = await f.run("subscription", "medium", "subscription", "subscription");
		await f.accounting.verifyRate({
			...f.rate,
			id: "subscription-rate",
			billing: "subscription",
			inputMicrosPerMillion: 0,
			generatedMicrosPerMillion: 0,
		});
		await assert.rejects(
			f.accounting.admit("subscription", approval.id, "medium", { ...openGates, subscriptionPaused: true }),
			/gate/,
		);
		await f.accounting.admit("subscription", approval.id, "medium", openGates);
		await assert.rejects(f.accounting.reserve(f.request("subscription", "paid")), /fallback/);
		const reservation = await f.accounting.reserve(f.request("subscription", "sub", { rateId: "subscription-rate" }));
		assert.equal(reservation.reserved.moneyMicros, 0);
		assert.equal(reservation.reserved.inputTokens, 1000);
	} finally {
		await f.close();
	}
});

test("classifier included once, final-output reserve and fixed session profile", async () => {
	const f = await reviewFixture();
	try {
		await f.run("run", "low");
		await f.accounting.admit("run", "run-approval", "low", openGates);
		await assert.rejects(f.accounting.reserve(f.request("run", "too-big", { generatedTokens: 5101 })), /15%/);
		await f.accounting.reserve(
			f.request("run", "classifier", { phase: "classifier", inputTokens: 12_000, generatedTokens: 1200 }),
		);
		await f.accounting.send("classifier", openGates);
		await f.accounting.settle("classifier");
		await assert.rejects(f.accounting.reserve(f.request("run", "retry", { phase: "classifier" })), /Classifier/);
		await f.accounting.finish("run");
		await f.run("session", "session");
		await assert.rejects(f.accounting.admit("session", "session-approval", "low", openGates), /profile/);
		await f.accounting.admit("session", "session-approval", "session", openGates);
		await assert.rejects(
			f.accounting.reserve(f.request("session", "classified", { phase: "classifier" })),
			/Classifier/,
		);
	} finally {
		await f.close();
	}
});

test("escalation is a new authorized total, not additive or a budget reset", async () => {
	const f = await reviewFixture();
	try {
		const { approval } = await f.run("run", "low");
		await f.accounting.admit("run", approval.id, "low", openGates);
		await f.accounting.reserve(f.request("run", "first", { inputTokens: 30_000 }));
		await f.accounting.send("first", openGates);
		await f.accounting.settle("first");
		await f.accounting.admit("run", approval.id, "medium", openGates);
		await assert.rejects(
			f.accounting.reserve(f.request("run", "without-consent", { inputTokens: 10_000 })),
			/inputTokens/,
		);
		await f.accounting.grant({ ...approval, id: "expanded", allowance: { ...REVIEW_PROFILES.medium } });
		await f.accounting.admit("run", "expanded", "medium", openGates);
		await assert.rejects(
			f.accounting.reserve(f.request("run", "additive", { approvalId: "expanded", inputTokens: 100_000 })),
			/inputTokens/,
		);
		await assert.rejects(f.accounting.admit("run", "expanded", "low", openGates), /upward/);
		f.advance(REVIEW_PROFILES.medium.durationMs);
		await assert.rejects(f.accounting.reserve(f.request("run", "late", { approvalId: "expanded" })), /wall-time/);
	} finally {
		await f.close();
	}
});

for (const bound of ["money", "input", "generated"] as const)
	test(`shared rolling ceiling counts ${bound} across runs and restart`, async () => {
		const f = await reviewFixture();
		try {
			await f.accounting.verifyRate({
				...f.rate,
				id: "shared-rate",
				inputMicrosPerMillion: bound === "money" ? 1 : 1_000_000,
				generatedMicrosPerMillion: bound === "money" ? 1_000_000_000 : 1_000_000,
			});
			for (const id of ["a", "b"]) {
				await f.run(id, "high");
				await f.accounting.admit(id, `${id}-approval`, "high", openGates);
				await f.accounting.reserve(
					f.request(id, `${id}-full`, {
						rateId: "shared-rate",
						phase: "final",
						inputTokens: bound === "input" ? 300_000 : 0,
						generatedTokens: bound === "generated" ? 24_000 : bound === "money" ? 10_000 : 1,
					}),
				);
				await f.accounting.send(`${id}-full`, openGates);
				await f.accounting.settle(`${id}-full`);
				await f.accounting.finish(id);
			}
			await f.restart();
			await f.run("c", "high");
			await f.accounting.admit("c", "c-approval", "high", openGates);
			await assert.rejects(f.accounting.reserve(f.request("c", "extra", { rateId: "shared-rate" })), /rolling/);
		} finally {
			await f.close();
		}
	});

test("uncertain charges do not age out; reconciled charges use a rolling 24h window", async () => {
	const f = await reviewFixture();
	try {
		await f.accounting.verifyRate({
			...f.rate,
			id: "expensive",
			inputMicrosPerMillion: 1,
			generatedMicrosPerMillion: 1_000_000_000,
		});
		for (const id of ["a", "b"]) {
			await f.run(id, "high");
			await f.accounting.admit(id, `${id}-approval`, "high", openGates);
			await f.accounting.reserve(
				f.request(id, `${id}-call`, { rateId: "expensive", inputTokens: 0, generatedTokens: 10_000 }),
			);
			await f.accounting.send(`${id}-call`, openGates);
			await f.accounting.settle(`${id}-call`);
			await f.accounting.finish(id);
		}
		f.advance(86400_001);
		await f.restart();
		await f.run("c", "high");
		await f.accounting.admit("c", "c-approval", "high", openGates);
		await assert.rejects(f.accounting.reserve(f.request("c", "later")), /rolling/);
		for (const id of ["a", "b"])
			await f.accounting.settle(`${id}-call`, { inputTokens: 0, generatedTokens: 10_000, durationMs: 1000 });
		await f.accounting.reserve(f.request("c", "later"));
		f.advance(-1);
		await assert.rejects(f.accounting.send("later", openGates), /backwards/);
	} finally {
		await f.close();
	}
});

test("provider overrun remains charged and blocks further admission to calls", async () => {
	const f = await reviewFixture();
	try {
		await f.run("run");
		await f.accounting.admit("run", "run-approval", "medium", openGates);
		await f.accounting.reserve(f.request("run"));
		await f.accounting.send("run-call", openGates);
		await f.accounting.settle("run-call", { inputTokens: 2000, generatedTokens: 2000, durationMs: 1000 });
		await f.restart();
		await f.accounting.admit("run", "run-approval", "medium", openGates);
		await assert.rejects(f.accounting.reserve(f.request("run", "overrun")), /overrun/);
	} finally {
		await f.close();
	}
});
