import assert from "node:assert/strict";
import test from "node:test";
import { UpdateReservation } from "./update-reservation.ts";

const operation = "12345678-1234-1234-1234-123456789abc";
function fixture() {
	let clock = 0,
		frozen = 0,
		blocked = false;
	const reservation = new UpdateReservation(
		{
			freezeAdmissions() {
				frozen++;
				return () => {
					frozen--;
				};
			},
			async blockers() {
				return blocked ? [{ kind: "busy", id: "owned" }] : [];
			},
		},
		() => clock,
		100,
	);
	return {
		reservation,
		frozen: () => frozen,
		busy: () => {
			blocked = true;
		},
		expire: () => {
			clock = 100;
		},
	};
}
test("reservation continuously fences idle admissions until exact cancellation", async () => {
	const f = fixture();
	try {
		const receipt = await f.reservation.prepare(operation);
		assert.equal(f.frozen(), 1);
		assert.deepEqual(f.reservation.verify(receipt), receipt);
		assert.throws(() => f.reservation.cancel({ ...receipt, token: "wrong" }));
		assert.equal(f.frozen(), 1);
		f.reservation.cancel(receipt);
		assert.equal(f.frozen(), 0);
		assert.throws(() => f.reservation.verify(receipt));
		await assert.rejects(f.reservation.prepare(operation));
	} finally {
		f.reservation.close();
	}
});
test("expired ownership never renews or authorizes a delayed helper", async () => {
	const f = fixture();
	try {
		const receipt = await f.reservation.prepare(operation);
		f.expire();
		assert.throws(() => f.reservation.verify(receipt));
		assert.equal(f.frozen(), 0);
		await assert.rejects(f.reservation.prepare(operation));
	} finally {
		f.reservation.close();
	}
});
test("busy and closed reservations release their freeze without stopping work", async () => {
	const f = fixture();
	f.busy();
	await assert.rejects(f.reservation.prepare(operation));
	assert.equal(f.frozen(), 0);
	f.reservation.close();
	await assert.rejects(f.reservation.prepare("22345678-1234-1234-1234-123456789abc"));
});
test("concurrent and shutdown-during-inspection admissions cannot publish a receipt", async () => {
	let resume!: () => void;
	let frozen = 0;
	const gate = new UpdateReservation({
		freezeAdmissions() {
			frozen++;
			return () => {
				frozen--;
			};
		},
		async blockers() {
			await new Promise<void>((resolve) => {
				resume = resolve;
			});
			return [];
		},
	});
	const pending = gate.prepare(operation);
	await assert.rejects(gate.prepare("22345678-1234-1234-1234-123456789abc"));
	gate.close();
	resume();
	await assert.rejects(pending);
	assert.equal(frozen, 0);
});

test("an early expiry callback reschedules rather than leaving an orphan freeze", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let clock = 0,
		frozen = 0;
	const gate = new UpdateReservation(
		{
			freezeAdmissions() {
				frozen++;
				return () => {
					frozen--;
				};
			},
			async blockers() {
				return [];
			},
		},
		() => clock,
		100,
	);
	try {
		await gate.prepare(operation);
		clock = 99.5;
		t.mock.timers.tick(100);
		assert.equal(frozen, 1);
		clock = 100;
		t.mock.timers.tick(1);
		assert.equal(frozen, 0);
	} finally {
		gate.close();
	}
});
