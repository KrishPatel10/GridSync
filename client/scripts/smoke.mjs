// End-to-end smoke test against a running GridSync API, using real SignalR clients.
//
//   cd server && dotnet run --project src/GridSync.Api
//   cd client && npm run smoke                      (or GRIDSYNC_URL=http://localhost:4200 npm run smoke
//                                                    to go through the Angular dev-server proxy)
//
// Exits non-zero if any check fails.
import { HttpTransportType, HubConnectionBuilder, LogLevel } from '@microsoft/signalr';

const BASE = process.env.GRIDSYNC_URL ?? 'http://localhost:5080';
// Set GRIDSYNC_WS_ONLY=1 to forbid fallback transports, e.g. to prove a proxy passes WebSockets through.
const WS_ONLY = process.env.GRIDSYNC_WS_ONLY === '1';
const SHEET = `smoke-${Date.now().toString(36)}`;
let failures = 0;

function check(name, condition, detail = '') {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${name}${!condition && detail ? `  (${detail})` : ''}`);
  if (!condition) failures++;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function client(name, nodeId) {
  const connection = new HubConnectionBuilder()
    .withUrl(`${BASE}/hubs/sheet`, WS_ONLY ? { transport: HttpTransportType.WebSockets, skipNegotiation: true } : {})
    .configureLogging(LogLevel.Error)
    .build();
  const received = [];
  const presence = [];
  // Handlers must not return a value: SignalR treats a return value as a reply to the server.
  connection.on('opsApplied', (ops) => {
    received.push(...ops);
  });
  connection.on('presenceChanged', (p) => {
    presence.push(p);
  });
  await connection.start();
  const joined = await connection.invoke('JoinSheet', SHEET, nodeId, name, '#C2255C');
  return { connection, joined, received, presence, nodeId };
}

const op = (row, col, value, wallMs, counter, nodeId) => ({ row, col, value, ts: { wallMs, counter, nodeId } });
const now = Date.now();

// 1. Two people join the same sheet.
const alice = await client('Alice', 'alice01');
const bob = await client('Bob', 'bob01');
check('join returns sheet size', alice.joined.rows === 100_000 && alice.joined.cols === 26, JSON.stringify(alice.joined));
check('second joiner sees the first in presence', bob.joined.users.some((u) => u.nodeId === 'alice01'));
await sleep(150);
check('first joiner is told about the second', alice.presence.some((p) => p.nodeId === 'bob01'));

// 2. An edit from Alice reaches Bob, and not Alice herself.
let result = await alice.connection.invoke('ApplyOps', [op(0, 0, 'hello', now, 0, 'alice01')]);
check('edit accepted', result.accepted === 1 && result.stale === 0, JSON.stringify(result));
await sleep(150);
check('edit is broadcast to others', bob.received.some((o) => o.value === 'hello' && o.ts.nodeId === 'alice01'));
check('edit is not echoed to its author', alice.received.length === 0);

// 3. Conflict: both edit B2. Bob's timestamp is later, so Bob wins everywhere, whatever the arrival order.
await Promise.all([
  bob.connection.invoke('ApplyOps', [op(1, 1, 'bob wins', now + 10, 0, 'bob01')]),
  alice.connection.invoke('ApplyOps', [op(1, 1, 'alice loses', now + 5, 0, 'alice01')]),
]);

// 4. Resending the same edit (a retry after a dropped connection) is harmless.
result = await alice.connection.invoke('ApplyOps', [op(0, 0, 'hello', now, 0, 'alice01')]);
check('duplicate edit is counted as stale, not re-applied', result.accepted === 0 && result.stale === 1, JSON.stringify(result));

// 5. Clearing a cell leaves a tombstone.
await bob.connection.invoke('ApplyOps', [op(0, 0, null, now + 20, 0, 'bob01')]);

// 6. The server refuses edits it shouldn't trust.
result = await alice.connection.invoke('ApplyOps', [
  op(0, 5, 'far future', now + 10 * 60_000, 0, 'alice01'),
  op(0, 6, 'pretending to be Bob', now + 30, 0, 'bob01'),
  op(100_000, 0, 'off the sheet', now + 30, 0, 'alice01'),
  op(0, 7, 'x'.repeat(10_001), now + 30, 0, 'alice01'),
]);
const reasons = result.rejected.map((r) => r.reason).sort().join(',');
check(
  'rejects future timestamps, borrowed node ids, out-of-range cells, oversized values',
  reasons === 'NodeIdMismatch,OutOfBounds,TimestampTooFarInFuture,ValueTooLong',
  reasons,
);

// 7. Someone who joins later gets the converged state, tombstone included.
const carol = await client('Carol', 'carol01');
const cell = (row, col) => carol.joined.cells.find((c) => c.row === row && c.col === col);
check('late joiner sees the conflict winner', cell(1, 1)?.value === 'bob wins', JSON.stringify(cell(1, 1)));
check('late joiner sees the clear as a tombstone', cell(0, 0) !== undefined && cell(0, 0).value === null, JSON.stringify(cell(0, 0)));
check('late joiner does not see rejected edits', !carol.joined.cells.some((c) => c.col >= 5));

// 8. A burst of 500 edits in one batch (the paste case).
const batch = Array.from({ length: 500 }, (_, i) => op(10 + i, 2, `row ${i}`, now + 40, 0, 'carol01'));
const started = performance.now();
result = await carol.connection.invoke('ApplyOps', batch);
const elapsed = performance.now() - started;
check(`500-edit batch accepted (${elapsed.toFixed(0)} ms round trip)`, result.accepted === 500, JSON.stringify(result));
await sleep(300);
check('whole batch reaches the others', alice.received.filter((o) => o.ts.nodeId === 'carol01').length === 500);

// 9. Leaving removes presence.
let leftId = null;
alice.connection.on('presenceLeft', (id) => {
  leftId = id;
});
const carolConnectionId = carol.joined.connectionId;
await carol.connection.stop();
await sleep(200);
check('others are told when someone leaves', leftId === carolConnectionId);

await Promise.all([alice.connection.stop(), bob.connection.stop()]);
console.log(failures === 0 ? '\nAll checks passed.' : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
