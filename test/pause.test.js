import { test } from "node:test";
import assert from "node:assert/strict";
import { isBlocked, on509, manualPause, resume, cancel } from "../src/pause.js";

function harness(cooldownMs = 1000) {
  let t = 0; let timerCount = 0; const ticks = [];
  const deps = {
    cooldownMs,
    now: () => t,
    setTimer: (fn) => { timerCount++; ticks.push(fn); return timerCount; },
    clearTimer: () => {},
    onStatus: () => {},
  };
  return { deps, advance: (ms) => { t += ms; }, fire: () => ticks.forEach((fn) => fn()), timerCount: () => timerCount };
}

function freshState() { return { paused:false, manualPause:false, userCancelled:false, quotaHit:true, cancelled:false, _iv:null }; }

test("on509 pauses and keeps quotaHit true during the pause (no sibling race)", () => {
  const h = harness(1000); const s = freshState();
  on509(s, h.deps);
  assert.equal(s.paused, true);
  assert.equal(isBlocked(s), true);
  assert.equal(s.quotaHit, true, "quotaHit must stay true while paused so siblings still gate");
});

test("cooldown expiry reopens the gate and clears quotaHit", () => {
  const h = harness(1000); const s = freshState();
  on509(s, h.deps);
  h.advance(1000); h.fire();
  assert.equal(s.paused, false);
  assert.equal(s.quotaHit, false, "quotaHit cleared only on reopen");
  assert.equal(isBlocked(s), false);
});

test("concurrent on509 does not start a second cooldown", () => {
  const h = harness(1000); const s = freshState();
  on509(s, h.deps);
  on509(s, h.deps); // sibling worker, same tick
  assert.equal(h.timerCount(), 1, "second on509 must early-return while paused");
  assert.equal(s.quotaHit, true);
});

test("cancel during a 509 pause unblocks permanently", () => {
  const h = harness(100000); const s = freshState();
  on509(s, h.deps);
  assert.equal(isBlocked(s), true);
  cancel(s, h.deps);
  assert.equal(s.userCancelled, true);
  assert.equal(s.cancelled, true);
  assert.equal(isBlocked(s), false, "userCancelled overrides paused");
});

test("manual pause blocks until resume", () => {
  const h = harness(); const s = { paused:false, manualPause:false, userCancelled:false, quotaHit:false, cancelled:false, _iv:null };
  manualPause(s);
  assert.equal(isBlocked(s), true);
  resume(s, h.deps);
  assert.equal(isBlocked(s), false);
});
