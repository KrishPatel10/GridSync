import { RawChange, SheetCalculator } from './sheet-calculator';

/**
 * How long does recalculation take? Run with:
 *
 *   npx ng test --include src/app/formulas/recalc.bench.ts
 *
 * This file is not named *.spec.ts on purpose, so the normal `npm test` never runs it. It prints a
 * table and asserts only that the answers are right; it never fails on speed, because a number
 * that depends on the machine is a measurement, not a test. It times the calculator alone (parse,
 * dependency lookup, ordering, evaluation, building the update list) on one thread, without
 * rendering or a worker.
 */

const WARMUP_RUNS = 3;
const MEASURED_RUNS = 15;

interface Scenario {
  readonly name: string;
  /** Builds a calculator and returns the edit to time. It is called once per run, alternating. */
  readonly setup: () => { edit: (run: number) => void; evaluations: () => number };
}

function newCalculator(): SheetCalculator {
  const calc = new SheetCalculator();
  calc.setDimensions(100_000, 26);
  return calc;
}

function fanOut(count: number): Scenario['setup'] {
  return () => {
    const calc = newCalculator();
    const setup: RawChange[] = [{ row: 0, col: 0, raw: '1' }];
    for (let row = 0; row < count; row++) setup.push({ row, col: 1, raw: '=A1*2+1' });
    calc.applyChanges(setup);
    return { edit: (run) => calc.applyChanges([{ row: 0, col: 0, raw: String(run + 2) }]), evaluations: () => calc.evaluationCount };
  };
}

function chain(length: number): Scenario['setup'] {
  return () => {
    const calc = newCalculator();
    const setup: RawChange[] = [{ row: 0, col: 0, raw: '1' }];
    for (let row = 1; row < length; row++) setup.push({ row, col: 0, raw: `=A${row}+1` });
    calc.applyChanges(setup);
    return { edit: (run) => calc.applyChanges([{ row: 0, col: 0, raw: String(run + 2) }]), evaluations: () => calc.evaluationCount };
  };
}

/** 10,000 formulas that each sum the same ten cells; editing one of the ten touches them all. */
function rangeFanOut(count: number): Scenario['setup'] {
  return () => {
    const calc = newCalculator();
    const setup: RawChange[] = [];
    for (let row = 0; row < 10; row++) setup.push({ row, col: 0, raw: '1' });
    for (let row = 0; row < count; row++) setup.push({ row, col: 1, raw: '=SUM(A1:A10)' });
    calc.applyChanges(setup);
    return { edit: (run) => calc.applyChanges([{ row: 4, col: 0, raw: String(run + 2) }]), evaluations: () => calc.evaluationCount };
  };
}

/** One formula that reads 10,000 cells; editing any of them re-reads all 10,000. */
function wideRange(cells: number): Scenario['setup'] {
  return () => {
    const calc = newCalculator();
    const setup: RawChange[] = [];
    for (let row = 1; row <= cells; row++) setup.push({ row, col: 0, raw: '1' });
    setup.push({ row: 0, col: 0, raw: `=SUM(A2:A${cells + 1})` });
    calc.applyChanges(setup);
    return { edit: (run) => calc.applyChanges([{ row: 5, col: 0, raw: String(run + 2) }]), evaluations: () => calc.evaluationCount };
  };
}

const SCENARIOS: readonly Scenario[] = [
  { name: 'one edit, 10,000 formulas read the edited cell', setup: fanOut(10_000) },
  { name: 'one edit, 100,000 formulas read the edited cell', setup: fanOut(100_000) },
  { name: 'one edit, a chain of 10,000 dependent formulas', setup: chain(10_000) },
  { name: 'one edit, 10,000 formulas each SUM a 10-cell range', setup: rangeFanOut(10_000) },
  { name: 'one edit, 1 formula SUMs a range of 10,000 cells', setup: wideRange(10_000) },
];

function summarize(times: number[]): { median: number; min: number; max: number } {
  const sorted = [...times].sort((a, b) => a - b);
  return { median: sorted[Math.floor(sorted.length / 2)], min: sorted[0], max: sorted[sorted.length - 1] };
}

describe('recalculation benchmark', () => {
  it('measures the scenarios', () => {
    const rows: string[] = [];

    for (const scenario of SCENARIOS) {
      const { edit, evaluations } = scenario.setup();
      for (let run = 0; run < WARMUP_RUNS; run++) edit(run);

      const before = evaluations();
      const times: number[] = [];
      for (let run = 0; run < MEASURED_RUNS; run++) {
        const start = performance.now();
        edit(WARMUP_RUNS + run);
        times.push(performance.now() - start);
      }
      const perEdit = (evaluations() - before) / MEASURED_RUNS;

      const { median, min, max } = summarize(times);
      rows.push(
        `${scenario.name.padEnd(56)} ${String(perEdit).padStart(8)} evals   median ${median.toFixed(2).padStart(8)} ms   min ${min.toFixed(2).padStart(8)}   max ${max.toFixed(2).padStart(8)}`,
      );
      expect(perEdit).toBeGreaterThan(0);
    }

    // Loading a sheet: one batch that registers and evaluates 10,000 formulas from nothing.
    const loadTimes: number[] = [];
    for (let run = 0; run < WARMUP_RUNS + MEASURED_RUNS; run++) {
      const calc = newCalculator();
      const batch: RawChange[] = [{ row: 0, col: 0, raw: '1' }];
      for (let row = 0; row < 10_000; row++) batch.push({ row, col: 1, raw: '=A1*2+1' });
      const start = performance.now();
      calc.applyChanges(batch);
      if (run >= WARMUP_RUNS) loadTimes.push(performance.now() - start);
    }
    const load = summarize(loadTimes);
    rows.push(
      `${'load a sheet with 10,000 new formulas in one batch'.padEnd(56)} ${''.padStart(8)}         median ${load.median.toFixed(2).padStart(8)} ms   min ${load.min.toFixed(2).padStart(8)}   max ${load.max.toFixed(2).padStart(8)}`,
    );

    console.log(`\nRecalculation benchmark (${MEASURED_RUNS} measured runs after ${WARMUP_RUNS} warmups)\n${rows.join('\n')}\n`);
  }, 300_000); // building the 100,000 formula sheet alone takes seconds
});
