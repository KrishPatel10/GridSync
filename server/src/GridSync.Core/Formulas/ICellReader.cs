namespace GridSync.Core.Formulas;

/// <summary>
/// How the evaluator sees the sheet. It only asks "what is cell (row, col) worth?", so it can be
/// tested with a dictionary today and driven by the dependency graph tomorrow.
/// </summary>
public interface ICellReader
{
    /// <summary>References outside this are #REF!.</summary>
    SheetDimensions Dimensions { get; }

    /// <summary>The value of a cell inside the sheet: a constant, or a formula's computed result.</summary>
    FormulaValue GetValue(int row, int col);
}
