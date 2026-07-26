// FTL ENGINE · tick — fixed-step scheduling, dependency-free.

// FIXED-STEP TICK SCHEDULER — simulation steps run in a MessageChannel
// macrotask OUTSIDE the rAF callback: the browser executes them in the
// idle gap between vsyncs, so a heavy tick delays at most the next frame
// instead of stacking on top of every frame's render cost. At most
// `maxPerTask` steps per task — a tab-restore backlog drains over a few
// tasks instead of freezing one — and a backlog deeper than
// `dropBacklogSteps` is dropped rather than marathon-replayed.
export class TickScheduler {
  constructor({ stepSec, run, maxPerTask = 3, dropBacklogSteps = 40 }) {
    this.stepSec = stepSec;
    this.run = run;
    this.maxPerTask = maxPerTask;
    this.dropBacklogSteps = dropBacklogSteps;
    this.acc = 0;
    const ch = new MessageChannel();
    this._port = ch.port2;
    ch.port1.onmessage = () => this._drain();
  }

  _drain() {
    let ran = 0;
    while (this.acc >= this.stepSec && ran++ < this.maxPerTask) {
      this.run();
      this.acc -= this.stepSec;
    }
    if (this.acc > this.stepSec * this.dropBacklogSteps) this.acc = 0;
    else if (this.acc >= this.stepSec) this._port.postMessage(0);
  }

  // call from the frame loop with the real delta; due steps are scheduled,
  // never run inline
  add(dtSec) {
    this.acc += dtSec;
    if (this.acc >= this.stepSec) this._port.postMessage(0);
  }
}
