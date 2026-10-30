# GridSync: project brief for Claude Code

Read this whole file at the start of every session. Update the Progress checklist and the Session log before ending a session. The README is the public document; this file is the working brief.

## What this is and why it exists

GridSync is a real-time collaborative spreadsheet. Several people edit the same sheet at once, anyone can drop offline, and when they reconnect every screen converges to the same state without locks or a server deciding who wins.

Stack: ASP.NET Core 10 + SignalR + EF Core on SQL Server (server), Angular 22 standalone, zoneless, signals (client).

Owner: Krish Patel, a full-stack engineer (Angular, TypeScript, Java, Spring Boot, .NET/C#) with about 3 years of experience, job hunting for SDE II / full-stack roles in India.

Purpose: a portfolio project that proves depth in .NET and Angular. It has to be:

- Demo-able in 60 seconds: two windows, go offline, edit both, reconnect, everything merges.
- Defensible for 45 minutes in an interview: every design choice has a reason Krish can explain.
- Honest: every number in the README or on the resume comes from a test or benchmark that actually ran.

Where it fits naturally, prefer technologies that close real gaps on Krish's resume (SQL Server, Azure, CI/CD). He had no cloud or SQL Server experience when this started, so never write anything implying experience he doesn't have.

## End goal

The project is done when all of these are true:

- [x] Public GitHub repo (`KrishPatel10/GridSync`) with CI on every push (build + all tests). Confirm the badge is green before claiming it.
- [ ] Live demo URL anyone can open in two tabs.
- [ ] README with a 20 to 30 second GIF of the offline-merge demo, an architecture diagram, and a "Numbers" section. Every number reproducible with a documented command, hardware stated. (Numbers section exists for the formula engine; load-test numbers are phase 4.)
- [x] Formula engine (phase 2) and persistence and row insertion (phase 3).
- [ ] Load and end-to-end testing (phase 4).
- [ ] Two or three resume bullets drafted from verified facts only.
- [ ] Interview prep list: the 10 most likely questions with short answers Krish has reviewed.

## Progress

Last verified 2026-10-30 against git history and a local test run. Re-verify before repeating any claim.

**Phase 1: live-synced grid (done).** HLC, LWW cells with CAS merge, tombstones, validation with a 60 s clock-skew guard; SignalR hub with join-before-snapshot, node-id binding, limits; hand-written virtual scroller for 100,000 x 26; optimistic edits, coalescing pending queue, reconnect, presence, paste, keyboard navigation.

**Phase 2: formula engine (done).** C# engine in `GridSync.Core.Formulas`, mirrored in TypeScript and run in a Web Worker. Shared conformance vectors live in `spec/` (`formula-vectors.json`, `recalc-vectors.json`, `fractional-index-vectors.json`). Circular references show `#CYCLE!`. Benchmarks: `npm run bench:formulas`, results in README "Numbers".

**Phase 3: persistence, durability, row insertion (done).** Append-only op log, snapshots, write-behind batching on SQL Server; unsent edits in IndexedDB; rows have stable ids ordered by fractional-index keys; protocol is versioned; FsCheck property tests.

**Also landed:** multi-cell selection with a footer summary, right-click menu, System/Light/Dark theme switch (`client/src/app/theme`, tokens use `light-dark()` in `styles.css`), GitHub Actions CI (`.github/workflows/ci.yml`), `docker-compose.yml`.

**Phase 4: prove it (next).**

- [ ] Playwright end-to-end tests with two browser contexts: typing and live sync; presence cursors and leave; offline queue then reconnect merge; same-cell conflict; paste; virtualization (row count in the DOM after Ctrl+End); clearing with Delete; zero console errors.
- [ ] Load test with N simulated clients. NBomber preferred, k6 acceptable. Measure p50/p95 edit-to-broadcast latency and sustained ops per second. Publish with hardware and exact command.
- [ ] Optional: OpenTelemetry metrics (ops applied, stale, rejected; broadcast latency).
- [ ] A Dockerfile per app (compose exists; check what it covers).

**Phase 5: ship it.**

- [ ] Deploy a live demo (Azure App Service with WebSockets, or Azure Container Apps). Check cost with Krish first; prefer free or low tiers.
- [ ] Record the README GIF and finish the Numbers section.
- [ ] Draft resume bullets and interview prep.

**Loose ends to check:**

- [ ] The flaky keyboard check "Enter moves down, Tab moves right" (failed once in 6 headless runs in phase 1, never reproduced). Reproduce with a stress test before changing `client/src/app/grid/grid.ts` (`onGridKeydown`, the `afterRenderEffect` that focuses the editor). Confirm whether it still happens.
- [ ] `dotnet test` reports NU1902/NU1903 warnings: `System.Security.Cryptography.Pkcs` 9.0.11 has known vulnerabilities. Look at which package pulls it in and bump it.
- [ ] Confirm the CI badge is green on GitHub (it can't be checked locally).

## Open questions for Krish (ask, don't assume)

- Phase 5 hosting target and monthly budget, which might be zero.
- Whether to add real sign-in later. Today identities are anonymous per tab.
- Whether to keep the commit history as is.

Settled: phase 3 database is SQL Server; circular references show `#CYCLE!`; repo is `KrishPatel10/GridSync`.

## Commands

Server, from `server/`: `dotnet build`, `dotnet test`, `dotnet run --project src/GridSync.Api` (http://localhost:5080). Needs the SQL Server from `docker compose up` unless you clear `ConnectionStrings:GridSync` (see README).

Client, from `client/` (Node version in `client/.nvmrc`): `npm install`, `npm start` (http://localhost:4200, proxies /hubs and /api to :5080), `npm test` (Vitest), `npx ng build`, `npm run bench:formulas`, `npm run smoke` (end-to-end checks against a running server; add `GRIDSYNC_URL=http://localhost:4200 GRIDSYNC_WS_ONLY=1` to go through the dev proxy over WebSockets only).

Last local run (2026-10-30): `dotnet test` 505 + 45 passed, `npm test` 624 passed (21 files).

## Architecture

- `server/src/GridSync.Core`: pure logic, no ASP.NET dependency. `HlcTimestamp`, `HybridLogicalClock`, `SheetState`, `OpValidator`, `Formulas/`, fractional index keys.
- `server/src/GridSync.Api`: `SheetHub` (JoinSheet, ApplyOps, SelectCell), plus the store, persistence and presence singletons.
- `client/src/app/sync`: `hlc.ts` and `lww-map.ts` mirror the C# logic; `sheet-sync.service.ts` owns the connection, the pending queue and presence.
- `client/src/app/grid`: the virtual scroller, keyboard handling, inline editor, paste, selection.
- `client/src/app/theme`: `ThemeService`. An inline script in `index.html` applies a saved theme before first paint.
- `spec/`: JSON vectors that both the xUnit and Vitest suites load.

## Invariants: never break these

- `HlcTimestamp.CompareTo` (C#) and `compareHlc` (`hlc.ts`) must order timestamps identically, including the ordinal node-id tie-break. Change both or neither.
- Merges stay commutative, associative and idempotent. A clear is a tombstone (null value), never a deletion.
- `JoinSheet` adds the connection to the group BEFORE taking the snapshot.
- Hub instances are transient. Shared state lives in singletons, never in hub fields.
- The hub rejects ops whose `ts.nodeId` differs from the node id the connection joined with.
- SignalR client handlers (`connection.on`) use block bodies. A returned value is treated as a reply to the server and logs errors.
- In flush, a pending op is cleared only if `pending.get(key) === op`.
- `SYNC_LIMITS` in `client/src/app/sync/sync.models.ts` matches the GridSync section of `server/src/GridSync.Api/appsettings.json`.
- The C# and TypeScript engines (formulas, fractional index) must pass the same vectors in `spec/`. Change the vectors, then both sides.
- Any change to the op format bumps the protocol version and updates both sides, the validator and the tests together.
- Colors in `styles.css` are `light-dark(light, dark)` tokens. Add new colors there, not in a media query.

## How to work with Krish

Session protocol:

- Start: read this file, then run the tests if code changed since the last session entry.
- During: work on the next unchecked item in order. Ask before starting a new phase, changing the wire protocol, or adding a dependency.
- End: tick the checkboxes, then append a Session log entry.

He is learning from this project. Explain the reasoning behind non-obvious decisions in a few sentences. When a new concept appears, give a short plain-language explanation before or alongside the code. Keep commits small and reviewable, one idea each.

Honesty rules:

- Never say tests pass without running them.
- Never invent metrics.
- If something is flaky or unverified, say so plainly, here and in the README.

Writing style for anything he'll read or publish (commits, README, docs, messages): no em dashes; use colons, commas, or pipes. Plain, direct language.

His machine runs Windows. Prefer commands that work in PowerShell, or state when something needs Git Bash or WSL.

## Known limitations

See the README "Known limitations" list; keep it as the single copy. Short version: the app needs one successful connection to load the sheet, same-cell concurrent edits keep one value by design, and sheets far beyond 100,000 rows need scaled scrolling.

## Session log

Newest at the bottom. Each entry: date, what changed, actual test results, open issues.

- 2026-09-20 (claude.ai): Phase 1 built. 16 xUnit (stand-in runner), 13 Vitest, 14 smoke checks. One flaky keyboard check noted above.
- 2026-09-20 to 2026-10-30: Phases 2 and 3 landed (see Progress). Theme switch added to the client, 5 tests.
- 2026-10-30 (Claude Code): created this file from the original brief, updated to match the repo. Ran `dotnet test` (505 + 45 passed, NU1902/NU1903 warnings) and `npm test` (624 passed). Not run: smoke, Playwright, build in CI.
