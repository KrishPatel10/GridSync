using GridSync.Core.Formulas;

namespace GridSync.Core.Tests.Formulas;

/// <summary>
/// The brief's property test: incremental recalculation must give exactly what recalculating from
/// scratch gives. Random sheets, random edit sequences (single edits and small batches), some
/// with cycles. After every edit, the incremental calculator is compared against an oracle.
/// </summary>
public class SheetCalculatorPropertyTests
{
    private const int Rows = 6;
    private const int Cols = 4;
    private const int Cells = Rows * Cols;

    /// <summary>
    /// A random cell: mostly formulas, and mostly reading cells that come earlier, so most sheets
    /// are acyclic. One reference in six can point anywhere, which now and then closes a cycle.
    /// </summary>
    private static string? RandomRaw(Random random, int self)
    {
        string Ref()
        {
            var index = self > 0 && random.NextDouble() < 0.85 ? random.Next(self) : random.Next(Cells);
            return CellAddress.ToA1(index / Cols, index % Cols);
        }
        string Range() => $"{Ref()}:{Ref()}";
        T Pick<T>(params T[] items) => items[random.Next(items.Length)];

        var roll = random.NextDouble();
        if (roll < 0.12) return null;
        if (roll < 0.30) return (random.Next(20) - 5).ToString();
        if (roll < 0.36) return Pick("hello", "x", "TRUE", "2.5");

        return Pick<Func<string>>(
            () => $"={Ref()}+{Ref()}",
            () => $"={Ref()}*2",
            () => $"=SUM({Range()})",
            () => $"=IF({Ref()}>3,{Ref()},{Ref()})",
            () => $"={Ref()}&\"x\"",
            () => $"=ROUND({Ref()}/3,1)",
            () => $"=-{Ref()}",
            () => $"=COUNT({Range()})",
            () => $"=MAX({Ref()},{Ref()},5)",
            () => $"=1/{Ref()}",
            () => $"={Ref()}",
            () => $"=AVERAGE({Range()})",
            () => "=1+")();
    }

    private sealed class FuncReader(Func<int, int, FormulaValue> read) : ICellReader
    {
        public SheetDimensions Dimensions => new(Rows, Cols);

        public FormulaValue GetValue(int row, int col) => read(row, col);
    }

    /// <summary>
    /// The reference answer: a deliberately different implementation. Plain recursion with
    /// memoizing, every cell computed from scratch, cycles found by noticing a cell that is
    /// already being computed. Only sheets this small are safe for recursion; the real calculator
    /// has no such limit.
    /// </summary>
    private static string[] Oracle(string?[] raws)
    {
        var memo = new Dictionary<int, (FormulaValue Value, bool Cyclic)>();
        var visiting = new HashSet<int>();
        FuncReader reader = null!; // Resolve uses the reader and the reader uses Resolve
        reader = new FuncReader((row, col) => Resolve(row * Cols + col).Value);

        static bool InSheet(CellRef cell) => cell.Row < Rows && cell.Col < Cols;

        static HashSet<int> DependenciesOf(Expr ast)
        {
            var found = new HashSet<int>();
            void Walk(Expr node)
            {
                switch (node)
                {
                    case CellRef cell:
                        if (InSheet(cell)) found.Add(cell.Row * Cols + cell.Col);
                        break;
                    case RangeRef range:
                        if (InSheet(range.BottomRight))
                        {
                            for (var r = range.TopLeft.Row; r <= range.BottomRight.Row; r++)
                            {
                                for (var c = range.TopLeft.Col; c <= range.BottomRight.Col; c++) found.Add(r * Cols + c);
                            }
                        }
                        break;
                    case Negate negate:
                        Walk(negate.Operand);
                        break;
                    case BinaryExpr binary:
                        Walk(binary.Left);
                        Walk(binary.Right);
                        break;
                    case FunctionCall call:
                        foreach (var arg in call.Args) Walk(arg);
                        break;
                }
            }
            Walk(ast);
            return found;
        }

        (FormulaValue Value, bool Cyclic) Resolve(int index)
        {
            if (memo.TryGetValue(index, out var known)) return known;

            var raw = raws[index];
            if (string.IsNullOrEmpty(raw)) return (FormulaValue.Empty, false);
            if (raw[0] != '=') return (FormulaValue.FromRaw(raw), false);

            if (!visiting.Add(index)) return (FormulaValue.FromError(FormulaError.Cycle), true);

            (FormulaValue, bool) result;
            try
            {
                var ast = FormulaParser.Parse(raw);
                var cyclic = false;
                foreach (var dependency in DependenciesOf(ast)) cyclic |= Resolve(dependency).Cyclic;
                result = cyclic
                    ? (FormulaValue.FromError(FormulaError.Cycle), true)
                    : (FormulaEvaluator.Evaluate(ast, reader), false);
            }
            catch (FormulaSyntaxException)
            {
                result = (FormulaValue.FromError(FormulaError.Syntax), false);
            }

            visiting.Remove(index);
            memo[index] = result;
            return result;
        }

        return raws.Select((raw, index) =>
            string.IsNullOrEmpty(raw) ? string.Empty : raw[0] == '=' ? Resolve(index).Value.ToDisplayString() : raw).ToArray();
    }

    private static string[] Displays(SheetCalculator calc, string?[] raws) =>
        raws.Select((raw, index) => calc.FormulaDisplayAt(index / Cols, index % Cols) ?? raw ?? string.Empty).ToArray();

    private static SheetCalculator NewCalculator()
    {
        var calc = new SheetCalculator();
        calc.SetDimensions(Rows, Cols);
        return calc;
    }

    private static void AssertSame(string[] expected, string[] actual, string context) =>
        Assert.True(
            expected.SequenceEqual(actual),
            $"{context}: expected [{string.Join(" | ", expected)}] but got [{string.Join(" | ", actual)}]");

    [Fact]
    public void Matches_a_from_scratch_recalculation_after_every_edit_on_random_sheets_with_cycles()
    {
        var checkedSteps = 0;
        var sheetsWithCycles = 0;

        for (var seed = 1; seed <= 60; seed++)
        {
            var random = new Random(seed * 7919);
            var raws = new string?[Cells];
            var incremental = NewCalculator();
            // A consumer that never looks at the calculator, only at the updates it is sent.
            var mirror = new Dictionary<long, string>();
            var sawCycle = false;

            for (var step = 0; step < 60; step++)
            {
                // Usually one edit; sometimes a small batch, like a paste or a merge of remote ops.
                var edits = random.NextDouble() < 0.2 ? 1 + random.Next(4) : 1;
                var changes = new List<RawChange>();
                for (var e = 0; e < edits; e++)
                {
                    var index = random.Next(Cells);
                    raws[index] = RandomRaw(random, index);
                    changes.Add(new RawChange(index / Cols, index % Cols, raws[index]));
                }

                foreach (var (key, display) in incremental.ApplyChanges(changes))
                {
                    if (display is null) mirror.Remove(key);
                    else mirror[key] = display;
                }

                var expected = Oracle(raws);
                AssertSame(expected, Displays(incremental, raws), $"seed {seed}, step {step}");
                sawCycle |= expected.Contains("#CYCLE!");

                // The updates alone must be enough to rebuild every formula's display.
                var fromUpdates = raws.Select((raw, index) =>
                    !string.IsNullOrEmpty(raw) && raw[0] == '='
                        ? mirror.GetValueOrDefault(SheetCalculator.CellKey(index / Cols, index % Cols), "(missing)")
                        : raw ?? string.Empty).ToArray();
                AssertSame(expected, fromUpdates, $"updates, seed {seed}, step {step}");

                // Recalculating everything in one batch on a fresh calculator must agree too.
                if (step % 10 == 9)
                {
                    var fresh = NewCalculator();
                    fresh.ApplyChanges(raws.Select((raw, index) => new RawChange(index / Cols, index % Cols, raw)));
                    AssertSame(expected, Displays(fresh, raws), $"fresh, seed {seed}, step {step}");
                }
                checkedSteps++;
            }
            if (sawCycle) sheetsWithCycles++;
        }

        // Guard the test itself: it must actually have exercised cycles, or it proves little.
        Assert.Equal(3_600, checkedSteps);
        Assert.True(sheetsWithCycles > 5, $"only {sheetsWithCycles} of 60 sheets ever contained a cycle");
    }
}
