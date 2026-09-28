// Decides when a card has been slid into the scan box and settled.
// Pure logic: feed it small grayscale frames of the scan box; it says when to scan.
//
// Rules:
// - Motion (frame-to-frame change) above MOTION starts a "moving" phase.
// - Once the frame stays still for STABLE_MS, the tracker looks at what settled:
//   - Close to the empty background: the box is empty. Remember that.
//   - Close to the last scanned frame, with no empty box in between: the same card
//     was nudged. Don't scan again.
//   - Otherwise: a new card. Scan it.
// So two copies of the same card count twice only if the box goes empty between them.

export const DEFAULTS = {
  MOTION: 7, // mean abs difference (0-255) between consecutive frames that counts as movement
  STABLE_MS: 450, // how long the frame must stay still before scanning
  EMPTY: 14, // difference from the background below which the box is empty
  SAME: 10, // difference from the last scanned frame below which it's the same card
  BG_ADAPT: 0.05, // how fast the background follows slow lighting changes while empty
};

// Mean absolute difference between two frames after removing each frame's mean brightness,
// so camera auto-exposure shifts don't read as change.
export function frameDiff(a, b) {
  const n = a.length;
  let ma = 0, mb = 0;
  for (let i = 0; i < n; i++) { ma += a[i]; mb += b[i]; }
  ma /= n; mb /= n;
  let d = 0;
  for (let i = 0; i < n; i++) d += Math.abs(a[i] - ma - (b[i] - mb));
  return d / n;
}

export class MotionTracker {
  constructor(opts = {}) {
    this.o = { ...DEFAULTS, ...opts };
    this.reset();
  }

  reset() {
    this.prev = null;
    this.background = null;
    this.lastScanned = null;
    this.sawEmpty = true;
    this.lastMotionAt = 0;
    this.state = 'calibrating'; // calibrating | empty | moving | holding | scanning
    this.stats = { motion: 0, fromBackground: 0, fromLast: 0 };
  }

  // Use the current view as the empty background (call while the box is empty).
  setBackground(frame) {
    this.background = Float32Array.from(frame);
    this.state = 'empty';
    this.sawEmpty = true;
  }

  // Returns 'scan' when a new card has settled, otherwise null.
  update(frame, now) {
    const o = this.o;
    if (!this.prev) {
      this.prev = frame;
      this.lastMotionAt = now;
      return null;
    }
    const motion = frameDiff(frame, this.prev);
    this.prev = frame;
    this.stats.motion = motion;
    if (this.state === 'scanning') return null;

    if (motion > o.MOTION) {
      this.lastMotionAt = now;
      if (this.state !== 'calibrating') this.state = 'moving';
      return null;
    }
    if (now - this.lastMotionAt < o.STABLE_MS) return null;

    if (this.state === 'calibrating') {
      this.setBackground(frame);
      return null;
    }

    const fromBackground = frameDiff(frame, this.background);
    this.stats.fromBackground = fromBackground;
    if (fromBackground < o.EMPTY) {
      this.state = 'empty';
      this.sawEmpty = true;
      const bg = this.background;
      for (let i = 0; i < bg.length; i++) bg[i] += (frame[i] - bg[i]) * o.BG_ADAPT;
      return null;
    }
    if (this.state !== 'moving') return null; // already handled this still frame

    const fromLast = this.lastScanned ? frameDiff(frame, this.lastScanned) : Infinity;
    this.stats.fromLast = fromLast;
    if (!this.sawEmpty && fromLast < o.SAME) {
      this.state = 'holding';
      return null;
    }
    this.state = 'scanning';
    this.pending = frame;
    return 'scan';
  }

  // Call after a scan finishes, whether or not a card was recognized.
  scanDone() {
    this.lastScanned = this.pending ?? this.prev; // a manual scan has no pending frame
    this.pending = null;
    this.sawEmpty = false;
    this.state = 'holding';
  }
}
