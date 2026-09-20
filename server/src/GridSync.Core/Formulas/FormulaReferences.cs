namespace GridSync.Core.Formulas;

public static class FormulaReferences
{
    /// <summary>
    /// Every cell and range a formula mentions, found by walking the whole tree, including the
    /// branch of an IF that will not run. That is deliberate: dependencies are about what a
    /// formula could read, so the graph never depends on the current values.
    ///
    /// Uses an explicit stack instead of recursion: the tree can be thousands of nodes deep on
    /// the left ("=1+1+1+..."), and a stack overflow in .NET ends the process.
    /// </summary>
    public static (List<CellRef> Cells, List<RangeRef> Ranges) Collect(Expr root)
    {
        var cells = new List<CellRef>();
        var ranges = new List<RangeRef>();
        var pending = new Stack<Expr>();
        pending.Push(root);

        while (pending.Count > 0)
        {
            switch (pending.Pop())
            {
                case CellRef cell:
                    cells.Add(cell);
                    break;
                case RangeRef range:
                    ranges.Add(range);
                    break;
                case Negate negate:
                    pending.Push(negate.Operand);
                    break;
                case BinaryExpr binary:
                    pending.Push(binary.Left);
                    pending.Push(binary.Right);
                    break;
                case FunctionCall call:
                    foreach (var arg in call.Args) pending.Push(arg);
                    break;
                // numbers, text and names read no cells
            }
        }

        return (cells, ranges);
    }
}
