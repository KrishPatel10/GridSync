import { compareHlc, HybridLogicalClock } from './hlc';

describe('HybridLogicalClock', () => {
  it('keeps increasing when the physical clock stands still', () => {
    const clock = new HybridLogicalClock('a', () => 1_000);
    const first = clock.tick();
    const second = clock.tick();
    expect(compareHlc(second, first)).toBe(1);
    expect(second.wallMs).toBe(first.wallMs);
  });

  it('keeps increasing when the physical clock goes backwards', () => {
    let now = 5_000;
    const clock = new HybridLogicalClock('a', () => now);
    const before = clock.tick();
    now = 2_000;
    expect(compareHlc(clock.tick(), before)).toBe(1);
  });

  it('orders an edit made after seeing a remote edit after it, even with a slow local clock', () => {
    const alice = new HybridLogicalClock('alice', () => 120_000);
    const bob = new HybridLogicalClock('bob', () => 0); // two minutes behind

    const aliceEdit = alice.tick();
    bob.receive(aliceEdit);
    expect(compareHlc(bob.tick(), aliceEdit)).toBe(1);
  });

  it('breaks exact ties by node id, the same way the server does', () => {
    const a = { wallMs: 1, counter: 1, nodeId: 'node-a' };
    const b = { wallMs: 1, counter: 1, nodeId: 'node-b' };
    expect(compareHlc(a, b)).toBe(-1);
    expect(compareHlc(b, a)).toBe(1);
    expect(compareHlc(a, a)).toBe(0);
  });
});
