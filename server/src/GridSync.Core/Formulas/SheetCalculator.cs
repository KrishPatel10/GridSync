namespace GridSync.Core.Formulas;

/// <summary>A cell's new raw text. Null or empty means the cell was cleared.</summary>
public readonly record struct RawChange(int Row, int Col, string? Raw);

/// <summary>
/// A change to what the sheet shows: the cell, and its new display text. A null display means the
/// cell is no longer a formula. Only cells whose display differs from what was last reported are
/// listed.
/// </summary>
public readonly record struct FormulaUpdate(long Key, string? Display);

/// <summary>
/// Turns a sheet of raw cell text into computed values, and keeps them right as cells change.
/// Mirrors client/src/app/formulas/sheet-calculator.ts step for step; the shared scenarios in
/// spec/recalc-vectors.json keep the two in agreement.
///
/// How an edit flows through (see Recalculate):
///   1. The edited cell is a "seed". Follow reverse edges ("who reads me?") to collect everything
///      downstream: the affected set. Nothing outside it can change, so nothing outside it is
///      touched. That is the "incremental" part.
///   2. Evaluate the affected formulas in dependency order, so a cell is never computed before the
///      cells it reads (topological order, by Kahn's algorithm: repeatedly take a cell with
///      nothing left to wait for).
///   3. Cells still waiting when nothing else is ready are stuck on each other: a cycle.
///
/// A formula is #CYCLE! if it is on a cycle or reads (even indirectly) a cell that is. This is
/// decided from what a formula could read, not from the values, so all replicas agree.
///
/// Not thread-safe: use one instance per sheet from one thread at a time.
/// </summary>
public sealed class SheetCalculator : ICellReader
{
    /// <summary>Same packing as cellKey in the client's lww-map.ts. Wider than int so a big sheet cannot overflow.</summary>
    private const int ColumnSpace = 16_384;

    private static readonly long[] NoKeys = [];

    private int _rows;
    private int _cols;

    /// <summary>Non-formula cells, already read as numbers or text. Empty cells are simply absent.</summary>
    private readonly Dictionary<long, FormulaValue> _constants = [];
    private readonly Dictionary<long, FormulaCell> _formulas = [];
    /// <summary>The computed result of every formula cell.</summary>
    private readonly Dictionary<long, FormulaValue> _values = [];
    /// <summary>Formula cells that are #CYCLE!: on a cycle, or reading one.</summary>
    private readonly HashSet<long> _cyclic = [];
    /// <summary>The display text last reported for each formula cell, so updates list only real changes.</summary>
    private readonly Dictionary<long, string> _reported = [];

    /// <summary>Reverse edges for single-cell reads: cell -> the formulas that read it directly.</summary>
    private readonly Dictionary<long, HashSet<long>> _dependents = [];

    /// <summary>
    /// Reverse edges for ranges. A range like A1:A100000 must not become 100,000 edges, so ranges
    /// stay as rectangles, filed under every column they span (a sheet has few columns). Finding
    /// "who reads cell (r, c)?" then means scanning only the ranges filed under column c.
    /// </summary>
    private readonly List<HashSet<RangeSub>?> _rangesByColumn = [];

    private long _evaluations;

    private sealed class RangeSub(long owner, int top, int bottom, int left, int right)
    {
        public long Owner { get; } = owner;
        public int Top { get; } = top;
        public int Bottom { get; } = bottom;
        public int Left { get; } = left;
        public int Right { get; } = right;
    }

    /// <param name="Raw">The text as entered.</param>
    /// <param name="Ast">Null when the text does not parse; the cell then shows #ERROR!.</param>
    /// <param name="Cells">Single cells it reads, without duplicates, only those inside the sheet.</param>
    private sealed record FormulaCell(string Raw, Expr? Ast, long[] Cells, RangeSub[] Ranges);

    public SheetDimensions Dimensions => new(_rows, _cols);

    /// <summary>How many formula evaluations have run, ever. Lets tests prove an edit only recomputes what it must.</summary>
    public long EvaluationCount => _evaluations;

    public int FormulaCount => _formulas.Count;

    public static long CellKey(int row, int col) => (long)row * ColumnSpace + col;

    public static int RowOf(long key) => (int)(key / ColumnSpace);

    public static int ColOf(long key) => (int)(key % ColumnSpace);

    /// <summary>
    /// References outside the sheet are #REF!, so the sheet size decides what each formula reads.
    /// It only changes when joining a sheet, so a change simply rebuilds everything.
    /// </summary>
    public IReadOnlyList<FormulaUpdate> SetDimensions(int rows, int cols)
    {
        ArgumentOutOfRangeException.ThrowIfGreaterThan(cols, ColumnSpace);
        if (rows == _rows && cols == _cols) return [];
        _rows = rows;
        _cols = cols;

        var existing = _formulas.ToList();
        foreach (var (key, formula) in existing) Unregister(key, formula);
        foreach (var (key, formula) in existing) Register(key, formula.Raw);
        return Recalculate(_formulas.Keys.ToList());
    }

    /// <summary>
    /// Applies a batch of edits, then recalculates once. A join snapshot arrives as one big batch.
    /// Returns what changed on screen, for a consumer that keeps its own copy of the displays.
    /// </summary>
    public IReadOnlyList<FormulaUpdate> ApplyChanges(IEnumerable<RawChange> changes)
    {
        var seeds = new List<long>();

        foreach (var (row, col, raw) in changes)
        {
            var key = CellKey(row, col);
            Clear(key);
            if (!string.IsNullOrEmpty(raw))
            {
                if (raw[0] == '=') Register(key, raw);
                else _constants[key] = FormulaValue.FromRaw(raw);
            }
            seeds.Add(key);
        }

        return Recalculate(seeds);
    }

    /// <summary>The value of any cell. This is also how the evaluator reads the sheet.</summary>
    public FormulaValue GetValue(int row, int col)
    {
        var key = CellKey(row, col);
        if (_formulas.ContainsKey(key)) return _values.GetValueOrDefault(key);
        return _constants.GetValueOrDefault(key);
    }

    public bool IsFormula(int row, int col) => _formulas.ContainsKey(CellKey(row, col));

    /// <summary>What to show in a formula cell, or null if the cell is not a formula.</summary>
    public string? FormulaDisplayAt(int row, int col)
    {
        var key = CellKey(row, col);
        if (!_formulas.ContainsKey(key)) return null;
        return _values.TryGetValue(key, out var value) ? value.ToDisplayString() : string.Empty;
    }

    // ----- keeping the dependency graph in step with the cells --------------------------------

    /// <summary>Forgets everything about a cell, ahead of it getting new contents.</summary>
    private void Clear(long key)
    {
        _constants.Remove(key);
        if (_formulas.Remove(key, out var formula)) Unregister(key, formula);
        _values.Remove(key);
        _cyclic.Remove(key);
    }

    /// <summary>Parses a formula and records what it reads, in both directions.</summary>
    private void Register(long key, string raw)
    {
        Expr? ast = null;
        try
        {
            ast = FormulaParser.Parse(raw);
        }
        catch (FormulaSyntaxException)
        {
            // stays null: the cell shows #ERROR!
        }

        var cells = new List<long>();
        var ranges = new List<RangeSub>();

        if (ast is not null)
        {
            var (referencedCells, referencedRanges) = FormulaReferences.Collect(ast);

            var seen = new HashSet<long>();
            foreach (var cell in referencedCells)
            {
                if (!InSheet(cell.Row, cell.Col)) continue; // evaluates to #REF!, reads nothing
                var target = CellKey(cell.Row, cell.Col);
                if (!seen.Add(target)) continue;
                cells.Add(target);

                if (!_dependents.TryGetValue(target, out var readers)) _dependents[target] = readers = [];
                readers.Add(key);
            }

            foreach (var range in referencedRanges)
            {
                if (!InSheet(range.BottomRight.Row, range.BottomRight.Col)) continue; // #REF! too
                var sub = new RangeSub(key, range.TopLeft.Row, range.BottomRight.Row, range.TopLeft.Col, range.BottomRight.Col);
                ranges.Add(sub);

                while (_rangesByColumn.Count <= sub.Right) _rangesByColumn.Add(null);
                for (var col = sub.Left; col <= sub.Right; col++) (_rangesByColumn[col] ??= []).Add(sub);
            }
        }

        _formulas[key] = new FormulaCell(raw, ast, [.. cells], [.. ranges]);
    }

    private void Unregister(long key, FormulaCell formula)
    {
        foreach (var target in formula.Cells)
        {
            if (!_dependents.TryGetValue(target, out var readers)) continue;
            readers.Remove(key);
            if (readers.Count == 0) _dependents.Remove(target);
        }

        foreach (var sub in formula.Ranges)
        {
            for (var col = sub.Left; col <= sub.Right; col++) _rangesByColumn[col]?.Remove(sub);
        }
    }

    private bool InSheet(int row, int col) => row < _rows && col < _cols;

    /// <summary>Every formula that reads this cell, directly or through a range, each listed once.</summary>
    private IReadOnlyList<long> DependentsOf(long key)
    {
        _dependents.TryGetValue(key, out var direct);

        List<long>? viaRanges = null;
        var col = ColOf(key);
        if (col < _rangesByColumn.Count && _rangesByColumn[col] is { Count: > 0 } bucket)
        {
            var row = RowOf(key);
            foreach (var sub in bucket)
            {
                if (row >= sub.Top && row <= sub.Bottom) (viaRanges ??= []).Add(sub.Owner);
            }
        }

        if (viaRanges is null) return direct is null ? NoKeys : [.. direct];

        // A formula can reach the same cell through several routes (two ranges, or a range and a cell).
        var all = new HashSet<long>(viaRanges);
        if (direct is not null) all.UnionWith(direct);
        return [.. all];
    }

    // ----- recalculation -----------------------------------------------------------------------

    private List<FormulaUpdate> Recalculate(IEnumerable<long> seedKeys)
    {
        // Step 1: the affected set, discovered breadth-first along reverse edges. Each edge that is
        // found is remembered, and each cell counts how many affected cells it is still waiting on.
        var affected = new List<long>();
        var known = new HashSet<long>();
        foreach (var key in seedKeys)
        {
            if (known.Add(key)) affected.Add(key);
        }

        var downstream = new Dictionary<long, IReadOnlyList<long>>();
        var waitingOn = new Dictionary<long, int>();
        for (var i = 0; i < affected.Count; i++)
        {
            var key = affected[i];
            var readers = DependentsOf(key);
            if (readers.Count == 0) continue;

            downstream[key] = readers;
            foreach (var reader in readers)
            {
                waitingOn[reader] = waitingOn.GetValueOrDefault(reader) + 1;
                if (known.Add(reader)) affected.Add(reader);
            }
        }

        // Anything about to be recomputed gets its cycle flag re-decided from scratch; flags on
        // cells outside the affected set are still valid and are kept.
        foreach (var key in affected) _cyclic.Remove(key);

        // Step 2: Kahn's algorithm. A cell is ready once every affected cell it reads is done.
        var ready = affected.Where(key => !waitingOn.ContainsKey(key)).ToList();
        for (var i = 0; i < ready.Count; i++)
        {
            var key = ready[i];
            Compute(key);

            if (!downstream.TryGetValue(key, out var readers)) continue;
            foreach (var reader in readers)
            {
                var remaining = waitingOn[reader] - 1;
                if (remaining == 0)
                {
                    waitingOn.Remove(reader);
                    ready.Add(reader);
                }
                else
                {
                    waitingOn[reader] = remaining;
                }
            }
        }

        // Step 3: whatever is still waiting is waiting on something that never finishes. That is
        // a cycle, or a cell reading one.
        foreach (var key in waitingOn.Keys) MarkCyclic(key);

        return CollectUpdates(affected);
    }

    /// <summary>Compares each affected cell's display with what was last reported, and lists the differences.</summary>
    private List<FormulaUpdate> CollectUpdates(List<long> affected)
    {
        var updates = new List<FormulaUpdate>();
        foreach (var key in affected)
        {
            if (_formulas.ContainsKey(key) && _values.TryGetValue(key, out var value))
            {
                var display = value.ToDisplayString();
                if (!_reported.TryGetValue(key, out var previous) || previous != display)
                {
                    _reported[key] = display;
                    updates.Add(new FormulaUpdate(key, display));
                }
            }
            else if (_reported.Remove(key))
            {
                updates.Add(new FormulaUpdate(key, null));
            }
        }
        return updates;
    }

    private void Compute(long key)
    {
        if (!_formulas.TryGetValue(key, out var formula)) return; // a constant, or a cleared cell

        if (formula.Ast is null)
        {
            _values[key] = FormulaValue.FromError(FormulaError.Syntax);
        }
        else if (_cyclic.Count > 0 && ReadsCyclicCell(formula))
        {
            MarkCyclic(key);
        }
        else
        {
            _evaluations++;
            _values[key] = FormulaEvaluator.Evaluate(formula.Ast, this);
        }
    }

    private void MarkCyclic(long key)
    {
        _cyclic.Add(key);
        _values[key] = FormulaValue.FromError(FormulaError.Cycle);
    }

    /// <summary>
    /// Catches a formula that was just edited to read a cycle that already existed: that cycle is
    /// not in the affected set, so the waiting-count above cannot see it. Checks the formula's own
    /// references against the flagged cells, walking whichever side is smaller.
    /// </summary>
    private bool ReadsCyclicCell(FormulaCell formula)
    {
        foreach (var target in formula.Cells)
        {
            if (_cyclic.Contains(target)) return true;
        }

        foreach (var sub in formula.Ranges)
        {
            var area = (long)(sub.Bottom - sub.Top + 1) * (sub.Right - sub.Left + 1);
            if (area <= _cyclic.Count)
            {
                for (var row = sub.Top; row <= sub.Bottom; row++)
                {
                    for (var col = sub.Left; col <= sub.Right; col++)
                    {
                        if (_cyclic.Contains(CellKey(row, col))) return true;
                    }
                }
            }
            else
            {
                foreach (var flagged in _cyclic)
                {
                    var row = RowOf(flagged);
                    var col = ColOf(flagged);
                    if (row >= sub.Top && row <= sub.Bottom && col >= sub.Left && col <= sub.Right) return true;
                }
            }
        }
        return false;
    }
}
