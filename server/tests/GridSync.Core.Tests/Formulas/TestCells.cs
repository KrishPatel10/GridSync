using GridSync.Core.Formulas;

namespace GridSync.Core.Tests.Formulas;

/// <summary>A sheet made of a dictionary: anything not in it is empty. Counts reads for laziness tests.</summary>
internal sealed class TestCells(SheetDimensions dimensions) : ICellReader
{
    private readonly Dictionary<(int Row, int Col), FormulaValue> _cells = [];

    public SheetDimensions Dimensions { get; } = dimensions;

    public int Reads { get; private set; }

    public TestCells() : this(new SheetDimensions(100_000, 26)) { }

    /// <summary>Puts a constant in a cell using A1 notation, read the way a typed cell is read.</summary>
    public TestCells Raw(string address, string? raw) => Value(address, FormulaValue.FromRaw(raw));

    public TestCells Value(string address, FormulaValue value)
    {
        Assert.True(CellAddress.TryParse(address, out var row, out var col), $"bad address {address}");
        _cells[(row, col)] = value;
        return this;
    }

    public FormulaValue GetValue(int row, int col)
    {
        Reads++;
        return _cells.TryGetValue((row, col), out var value) ? value : FormulaValue.Empty;
    }
}
