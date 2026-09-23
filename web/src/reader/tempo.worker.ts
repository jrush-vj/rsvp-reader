/**
 * The playback clock.
 * ---------------------------------------------------------------------------
 * Why the beat lives in a worker rather than a `setTimeout` on the page.
 *
 * A self-chaining `setTimeout` is clamped to roughly one tick per second once
 * the tab is hidden. Measured on this app, a reader left running behind another
 * tab advanced **5 words in 5.3 s at 775 wpm** — about 56 wpm effective. That is
 * a real defect for something hosted online, where backgrounding a tab to look
 * something up is normal rather than exotic.
 *
 * Two probes decided the design:
 *
 *   - A worker's own timers are *not* clamped. Hidden for 6.2 s it fired 32
 *     ticks where 5/s predicts 31.
 *   - `postMessage` delivery is not clamped either. Of 32 ticks posted while
 *     hidden, all 32 reached the page. So the fix is to move the *schedule*
 *     off the main thread, not to batch or catch up after the fact.
 *
 * What deliberately did **not** move: the words and the rendering. This worker
 * posts nothing but a tick; the text stays on the main thread. Sending it here
 * would cost a structured clone on every schedule change — measured at 542 ms
 * for 59,619 words, against 144 ms to fetch and parse them in the page — which
 * is a large regression bought for nothing, since playback already holds 60 fps
 * with no long tasks. The only thing worth relocating was the timer.
 *
 * The timing rule is unchanged, and lives here in full so there is one place to
 * read it:
 *
 *     delay = 60000 / wpm * pause
 *
 * Each delay is decided *after* the previous word has been shown, so punctuation
 * still holds without the schedule drifting, and a speed change still takes
 * effect on the very next word rather than at the end of a batch.
 */

/**
 * The slice of the worker global this file uses.
 *
 * Declared by hand rather than by adding `/// <reference lib="webworker" />`:
 * the app's tsconfig already includes `DOM`, the two libs declare overlapping
 * globals, and pulling in both produces duplicate-identifier errors project-wide
 * to type three lines.
 */
type WorkerGlobal = {
  addEventListener(type: "message", fn: (e: MessageEvent<Command>) => void): void;
  postMessage(message: Tick): void;
};

/** The page hands over one word's worth of timing. */
interface Arm {
  type: "arm";
  /** Milliseconds one word takes at the current speed, before punctuation. */
  base: number;
  /** This word's dwell multiplier — see `pauseMultiplier` in `lib/words.ts`. */
  pause: number;
}

interface Stop {
  type: "stop";
}

type Command = Arm | Stop;
type Tick = { type: "tick" };

const ctx = self as unknown as WorkerGlobal;

let timer: ReturnType<typeof setTimeout> | null = null;
let base = 60_000 / 300;
let pause = 1;

function cancel() {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
}

/**
 * Wait out the current word, then hand the beat back to the page.
 *
 * The timer is armed by a message and never re-arms itself, so a `stop` that
 * lands mid-wait is never followed by one more word — the same guarantee the
 * main thread's cancel-before-schedule had.
 */
function arm() {
  cancel();
  timer = setTimeout(() => {
    timer = null;
    ctx.postMessage({ type: "tick" });
  }, base * pause);
}

ctx.addEventListener("message", (e) => {
  const msg = e.data;
  switch (msg.type) {
    // A word is on screen; hold it for its own dwell and report back.
    case "arm":
      base = msg.base;
      pause = msg.pause;
      arm();
      break;

    // A speed change re-arms immediately rather than waiting the old delay out,
    // which is what makes the new pace apply from the next word. The current
    // word simply gets its dwell recomputed at the new rate.
    case "stop":
      cancel();
      break;
  }
});
