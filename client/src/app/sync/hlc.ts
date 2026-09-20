/**
 * Hybrid Logical Clock, mirrored from server/src/GridSync.Core/HybridLogicalClock.cs.
 * Both sides must order timestamps identically, or replicas stop converging.
 */
export interface HlcTimestamp {
  readonly wallMs: number;
  readonly counter: number;
  readonly nodeId: string;
}

/** Total order: wall time, then counter, then node id (code-unit order, same as C# CompareOrdinal). */
export function compareHlc(a: HlcTimestamp, b: HlcTimestamp): number {
  if (a.wallMs !== b.wallMs) return a.wallMs < b.wallMs ? -1 : 1;
  if (a.counter !== b.counter) return a.counter < b.counter ? -1 : 1;
  if (a.nodeId === b.nodeId) return 0;
  return a.nodeId < b.nodeId ? -1 : 1;
}

export class HybridLogicalClock {
  private lastWallMs = 0;
  private lastCounter = 0;

  constructor(
    readonly nodeId: string,
    private readonly now: () => number = Date.now,
  ) {}

  /** A timestamp for a new local edit, strictly greater than anything this clock has seen. */
  tick(): HlcTimestamp {
    const wall = this.now();
    if (wall > this.lastWallMs) {
      this.lastWallMs = wall;
      this.lastCounter = 0;
    } else {
      // Same millisecond, or the OS clock moved backwards: hold logical time, bump the counter.
      this.lastCounter++;
    }
    return { wallMs: this.lastWallMs, counter: this.lastCounter, nodeId: this.nodeId };
  }

  /** Folds in a timestamp from another replica so our next tick() sorts after it. */
  receive(remote: HlcTimestamp): void {
    const wall = this.now();
    const maxWall = Math.max(wall, this.lastWallMs, remote.wallMs);

    let counter: number;
    if (maxWall === this.lastWallMs && maxWall === remote.wallMs) {
      counter = Math.max(this.lastCounter, remote.counter) + 1;
    } else if (maxWall === this.lastWallMs) {
      counter = this.lastCounter + 1;
    } else if (maxWall === remote.wallMs) {
      counter = remote.counter + 1;
    } else {
      counter = 0;
    }

    this.lastWallMs = maxWall;
    this.lastCounter = counter;
  }
}
