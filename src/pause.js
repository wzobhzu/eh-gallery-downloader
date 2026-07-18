// Pause coordinator for the bulk manager. Unifies manual pause and 509 auto-pause
// (with an auto-reopening cooldown) over the SAME `state` object scrape.js reads,
// so pool()/fetchImage() see one source of truth. Clock + timer are injected so the
// cooldown is unit-testable without real time. quotaHit is cleared ONLY when the
// cooldown reopens — never eagerly — so concurrent workers that both observed a 509
// cannot race on a shared boolean.
export function isBlocked(state) {
  return (state.paused || state.manualPause) && !state.userCancelled;
}

// Called when a worker observes a 509. Idempotent while a cooldown is already running.
export function on509(state, deps) {
  if (state.paused) return;
  state.paused = true;
  const until = deps.now() + deps.cooldownMs;
  const tick = () => {
    if (state.userCancelled || deps.now() >= until) {
      if (state._iv != null) { deps.clearTimer(state._iv); state._iv = null; }
      state.paused = false;
      state.quotaHit = false;
      if (deps.onStatus && !state.userCancelled) deps.onStatus("resume");
    } else if (deps.onStatus) {
      deps.onStatus("cooldown", Math.ceil((until - deps.now()) / 60000));
    }
  };
  tick();
  if (state.paused) state._iv = deps.setTimer(tick, 5000);
}

export function manualPause(state) { state.manualPause = true; }

export function resume(state, deps) {
  if (state._iv != null) { deps.clearTimer(state._iv); state._iv = null; }
  state.paused = false; state.manualPause = false; state.quotaHit = false;
}

export function cancel(state, deps) { state.userCancelled = true; state.cancelled = true; resume(state, deps); }
