# GridSync

[![CI](https://github.com/kpatel-valorx/GridSync/actions/workflows/ci.yml/badge.svg)](https://github.com/kpatel-valorx/GridSync/actions/workflows/ci.yml)

A spreadsheet where several people can edit the same sheet at once, one of them can drop offline, and when they reconnect every screen ends up identical, without a central lock or a server deciding who wins.

**Stack:** ASP.NET Core 10 and SignalR on the server, Angular 22 (standalone, zoneless, signals) in the browser.

Phases 1 and 2 of 4 are done: a live-synced, virtualized grid with presence and offline edit merging, and a formula engine that runs in a Web Worker. Persistence, durable offline edits, and row insertion come next (see [Roadmap](#roadmap)).

## Run it

You need the .NET 10 SDK and Node.js 22.22.3+ or 24.15+.

```bash
# terminal 1: the sync server on http://localhost:5080
cd server
dotnet run --project src/GridSync.Api

# terminal 2: the Angular app on http://localhost:4200 (proxies /hubs and /api to the server)
cd client
npm install
npm start
```

Open http://localhost:4200 in two browser windows side by side. Use `?sheet=anything` in the address bar to open a different sheet.

## Try this

1. Type in one window. The other window shows the edit a moment later, flashing in the author's color, with their cursor and name tag on the cell.
2. Paste a block of cells copied from Excel or Google Sheets. It arrives in the other window as one batch.
3. Press **Go offline** in window A. Edit a few cells in both windows, including the same cell in both. The status bar in A counts the edits waiting to sync.
4. Press **Go online**. A's queued edits reach B, B's edits reach A (and flash so you can see what changed while you were away), and the cell you edited in both windows shows the same value everywhere.
5. Press Ctrl+End. You're on row 100,000, and the page still only has about 30 rows in it.
6. Type `10` in A1 and `=A1*2` in B1. B1 shows `20`, and the formula bar shows the formula. Change A1 in the *other* window and watch B1 follow in both. Then type `=B1` in A1 to make a loop: both cells show `#CYCLE!`, and go back to normal when you break it.

## How it works

```mermaid
sequenceDiagram
    participant A as Browser A
    participant H as SheetHub (SignalR)
    participant B as Browser B
    A->>A: apply edit locally, stamp with HLC time
    A->>H: ApplyOps([edits])
    H->>H: validate, merge (last writer wins per cell)
    H-->>B: OpsApplied([winning edits])
    B->>B: merge with the same rule
    H-->>A: { accepted, stale, rejected }
```

Every cell is a last-writer-wins register. Every edit carries a hybrid logical clock (HLC) timestamp, and the edit with the greater timestamp wins. That merge rule is commutative, associative, and idempotent, so any two replicas that have seen the same edits end up identical, no matter what order the edits arrived in or how many times they were delivered. The server, every browser, and the tests all use the same rule.

### Design decisions worth asking about

**Why a hybrid logical clock instead of wall-clock time?** If my laptop clock runs two minutes slow and I overwrite your edit after seeing it, wall-clock time says my edit is older and yours wins, which is the opposite of what I meant. An HLC folds in every timestamp it receives, so an edit made after seeing another edit always sorts after it, while staying close to real time. See `HybridLogicalClock.cs` and `hlc.ts` (same algorithm, same tie-break order).

**Why keep cleared cells as tombstones?** If clearing a cell deleted its entry, an offline replica still holding the old value would bring it back when it reconnects. A clear is stored as an edit whose value is null, and it wins or loses like any other edit.

**Why are retries safe?** Merges are idempotent: applying an edit twice changes nothing. So the client keeps unsent edits in a queue, resends them after a reconnect, and never needs to know whether a batch "half landed". The queue also coalesces: ten edits to the same cell while offline become one. And if you edit a cell again while its previous edit is in flight, the in-flight acknowledgment doesn't remove the newer edit (`pending.get(key) === op` in `sheet-sync.service.ts`).

**Why join the group before taking the snapshot?** A new client is added to the sheet's SignalR group first, then handed the snapshot. An edit landing in between may arrive twice (in the snapshot and as a broadcast), which is harmless. Doing it the other way round could lose it.

**Why is the server's merge lock-free?** `SheetState.Apply` uses a compare-and-swap loop on a `ConcurrentDictionary`: read the current value, decide, then `TryUpdate` only if nobody changed it in the meantime. Many hub calls can merge edits into the same sheet concurrently without a sheet-wide lock. A test hammers one cell from parallel threads to check the greatest timestamp always ends up in place.

**What does the server refuse to trust?** Clients can't stamp edits with timestamps more than 60 seconds in the future (otherwise a clock set to 2099 wins every conflict forever), can't use another replica's node id (which would let them win tie-breaks or disguise authorship), and are limited in batch size, value length, and number of sheets.

**Why a hand-written virtual scroller?** Only the rows on screen exist in the DOM. With fixed row heights, the visible range is pure arithmetic (`floor(scrollTop / rowHeight)`), the canvas height gives the scrollbar its true size, and one `translateY` slides the rendered window into place. Writing it by hand keeps the column headers and row numbers sticky on both axes and leaves room for column virtualization later.

## Formulas

A cell whose text starts with `=` is a formula. Only the raw text is synced, so the sync protocol and the merge rule did not change. Each browser computes the values itself, and because the evaluator is deterministic and every replica has the same text, every replica ends up with the same values. No computed value ever crosses the network.

| You can write | Examples |
|---|---|
| Numbers, text in double quotes | `=42`, `="hello"`, `="say ""hi"""` |
| Cell and range references | `=A1`, `=SUM(A1:B10)` |
| Arithmetic, joining, comparing | `=A1*2+1`, `=A1&" units"`, `=A1>=10`, `=-A1^2` |
| `SUM AVERAGE MIN MAX COUNT IF ROUND` | `=IF(A1>0,"up","down")`, `=ROUND(A1/3,2)` |

Errors are values: `#DIV/0!`, `#VALUE!`, `#REF!` (outside the sheet), `#NAME?` (unknown name or function), `#NUM!` (not a finite number), `#ERROR!` (text that does not parse), and `#CYCLE!`. Precedence follows Excel, including the quirks: `-2^2` is 4 and `2^3^2` is 64.

### How the engine works

```mermaid
flowchart LR
    T["raw text<br/>=SUM(A1:A3)*2"] --> K[tokenizer] --> P["Pratt parser"] --> E["AST"]
    E --> G["dependency graph<br/>(reverse edges)"]
    G --> R["recalculate<br/>affected cells only,<br/>in dependency order"]
    R --> V["computed values"]
```

**Parsing.** A hand-written tokenizer feeds a Pratt (precedence-climbing) parser: each operator has a binding power, and one loop absorbs operators for as long as they bind tighter than the caller. That gives correct precedence with no grammar tables, and left-associative chains like `1+1+1+...` run in a loop instead of recursing.

**Incremental recalculation.** When a cell changes, the calculator follows reverse edges ("who reads this cell?") to find everything downstream, and recomputes only those cells, each once, in dependency order (Kahn's algorithm). Ranges like `A1:A100000` are kept as rectangles, filed under the columns they span, instead of becoming 100,000 edges.

**Cycles.** Cells still waiting after Kahn's algorithm has finished are stuck on each other. A formula is `#CYCLE!` if it is on a loop or reads one, decided from what it *could* read (even inside an `IF` branch that will not run), so every replica agrees. Two people can create a loop without either of them ever seeing one: Alice sets `A1` to `=B1` while offline, Bob sets `B1` to `=A1`. Neither edit is a loop alone, so cycles are detected when computing, on every replica, not by rejecting edits. Nothing here recurses per cell, so a 100,000 cell loop or chain is fine.

**Two engines, one spec.** The evaluator and calculator exist in C# (`GridSync.Core.Formulas`) and TypeScript (`client/src/app/formulas`). The same JSON files drive both test suites: `spec/formula-vectors.json` (evaluation) and `spec/recalc-vectors.json` (edit sequences, including how many formulas each edit evaluates). The server does not need to compute anything for sync to work; the C# engine is the reference implementation that keeps the TypeScript one honest. It has already paid for itself: a shared vector showed that .NET breaks an exact tie when formatting 15 digits toward the even digit while JavaScript and Excel round away from zero, so the two engines would have printed different text for `=1000000000000005`.

**Off the UI thread.** In the browser the calculator runs in a Web Worker. The page sends raw cell changes, and the worker replies with the display text of only the formulas that changed. A formula shows blank for the moment the worker takes to answer, and everything that is not a formula appears at once. If the worker cannot start or fails, the page recomputes everything itself from the raw cells it already holds. Adding `?formulas=inline` to the address forces that in-page mode, for comparing the two.

## Tests

```bash
cd server && dotnet test         # 455 tests: HLC ordering, LWW merge, tombstones, validation, a seeded
                                 # convergence test, a parallel-writers test for the lock-free merge, and
                                 # the formula engine: parser, evaluator, calculator, cycles, 100,000 cell
                                 # chains, a property test (3,600 random edits vs an independent oracle)
cd client && npm test            # 486 tests: the same on the TypeScript side, plus the sync service
cd client && npm run smoke       # 14 end-to-end checks with real SignalR clients against a running server
```

`npm run smoke` needs the server running. Set `GRIDSYNC_URL=http://localhost:4200 GRIDSYNC_WS_ONLY=1` to run it through the Angular dev proxy over WebSockets only.

If the server is running, `dotnet test` on the whole solution can fail with a file-lock error, because the running server holds its own copy of `GridSync.Core.dll`. Run `dotnet test tests/GridSync.Core.Tests` instead, or stop the server first.

## Numbers

Every number here comes from a command you can run. Hardware: AMD Ryzen 7 5800H (8 cores, 16 threads), 63 GB RAM, Windows 11, Node 22.21.1, Vitest 4 on jsdom.

```bash
cd client && npm run bench:formulas
```

This times the calculator alone (parse, dependency lookup, ordering, evaluation, building the update list) on one thread, with no rendering and no worker. Each figure is the median of 15 runs after 3 warmups. The range is the lowest and highest of those medians across 4 separate runs of the command. The machine was also running a browser and dev servers, and the fourth run was the slowest, so treat the upper end as "on a busy laptop".

| One edit that... | Formulas recomputed | Median time |
|---|---|---|
| is read by 10,000 formulas | 10,000 | 15 to 18 ms |
| is read by 100,000 formulas | 100,000 | 190 to 250 ms |
| starts a chain of 10,000 dependent formulas | 9,999 | 15 to 19 ms |
| is inside a 10-cell range that 10,000 formulas each sum | 10,000 | 15 to 21 ms |
| is inside a 10,000-cell range that 1 formula sums | 1 | 0.2 to 0.3 ms |
| *Loading 10,000 new formulas in one batch (a join snapshot)* | 10,000 | 24 to 37 ms |

For scale: one frame at 60 Hz is 16.7 ms, so recalculating 10,000 dependents on the page's own thread costs about a frame, and 100,000 would freeze the page for 0.2 s or more. That is why formulas run in a worker. A manual check in the browser (not a repeatable command) agreed: with the worker, the edit handler stayed at a few milliseconds even with 100,000 dependents, where the in-page calculator blocked for several hundred.

These are single-thread costs on one machine, not a claim about other hardware.

## Project layout

```
server/
  src/GridSync.Core/        HLC, LWW sheet state, op validation (no ASP.NET dependency)
    Formulas/               tokenizer, parser, evaluator, dependency graph and calculator
  src/GridSync.Api/         SignalR hub, sheet store, presence tracking
  tests/GridSync.Core.Tests/
client/
  src/app/sync/             HLC, LWW map, SignalR sync service
  src/app/grid/             virtualized grid component
  src/app/formulas/         the same formula engine in TypeScript, plus the Web Worker
  scripts/smoke.mjs         end-to-end check against a live server
spec/
  formula-vectors.json      evaluation cases both engines must pass
  recalc-vectors.json       edit sequences both calculators must replay identically
```

## Known limitations

- Formulas: no absolute references (`$A$1`), no functions beyond the seven listed, no dates, and nothing to make text that starts with `=` stay text.
- A formula cell is blank for a moment after you type it, while the worker answers.
- The C# formula engine is not used by the server yet. It is the reference the TypeScript engine is tested against.
- Comparison is exact on numbers, so `=0.1+0.2=0.3` is `FALSE`. Excel quietly forgives that; this engine does not.

- Server state lives in memory and resets on restart.
- Unsent edits also live in memory: closing a tab while offline loses them (the page warns you first).
- The app needs to reach the server once to load the sheet; it can go offline after that.
- Two people editing the same cell at the same moment keep one value, not a merge of both texts. That's the intended rule for spreadsheet cells.
- The grid has a fixed 100,000 by 26 size. Inserting rows concurrently is a harder problem, planned for phase 3.
- Browsers cap element height (around 17 million pixels in Firefox), so going far past 100,000 rows needs scaled scrolling.

## Roadmap

1. **Phase 1 (done):** live sync, presence, offline merge, virtualized grid.
2. **Phase 2 (done):** a formula engine: parser, dependency graph between cells, incremental recalculation, cycle detection, evaluated in a Web Worker.
3. **Phase 3:** persistence (an append-only op log with periodic snapshots, EF Core), unsent edits stored in IndexedDB, and concurrent row insertion using fractional indexing. Property-based tests with FsCheck.
4. **Phase 4:** load testing with many simulated clients, Playwright end-to-end tests, and published numbers.
