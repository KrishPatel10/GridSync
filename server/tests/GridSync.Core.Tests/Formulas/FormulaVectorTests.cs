using System.Text.Json;
using GridSync.Core.Formulas;

namespace GridSync.Core.Tests.Formulas;

/// <summary>
/// Runs spec/formula-vectors.json, the file the TypeScript engine's tests run too. If the two
/// engines ever disagree about a formula, one of these two suites fails on the same line.
/// </summary>
public class FormulaVectorTests
{
    private sealed record Vector(string Name, string Formula, JsonElement Cells, JsonElement Expected);

    private static readonly Lazy<(SheetDimensions Dims, Dictionary<string, Vector> ByName)> File = new(Load);

    public static IEnumerable<object[]> Names() => File.Value.ByName.Keys.Select(name => new object[] { name });

    private static (SheetDimensions, Dictionary<string, Vector>) Load()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "formula-vectors.json");
        using var doc = JsonDocument.Parse(System.IO.File.ReadAllText(path));

        var sheet = doc.RootElement.GetProperty("sheet");
        var dims = new SheetDimensions(sheet.GetProperty("rows").GetInt32(), sheet.GetProperty("cols").GetInt32());

        var byName = new Dictionary<string, Vector>();
        foreach (var element in doc.RootElement.GetProperty("vectors").EnumerateArray())
        {
            var name = element.GetProperty("name").GetString()!;
            var cells = element.TryGetProperty("cells", out var c) ? c.Clone() : default;
            var vector = new Vector(name, element.GetProperty("formula").GetString()!, cells, element.GetProperty("expected").Clone());
            Assert.True(byName.TryAdd(name, vector), $"duplicate vector name: {name}");
        }
        return (dims, byName);
    }

    [Fact]
    public void The_vector_file_has_the_required_number_of_cases() =>
        Assert.True(File.Value.ByName.Count >= 60, $"only {File.Value.ByName.Count} vectors");

    [Fact]
    public void The_vectors_cover_every_operator_function_and_error()
    {
        var formulas = File.Value.ByName.Values.Select(v => v.Formula).ToList();
        var errors = File.Value.ByName.Values
            .Where(v => v.Expected.GetProperty("type").GetString() == "error")
            .Select(v => v.Expected.GetProperty("value").GetString())
            .ToHashSet();

        string[] operators = ["+", "-", "*", "/", "^", "&", "=", "<>", "<=", ">=", "<", ">"];
        string[] functions = ["SUM(", "AVERAGE(", "MIN(", "MAX(", "COUNT(", "IF(", "ROUND("];
        // #CYCLE! is not producible by the evaluator on its own; the dependency graph adds it later.
        string[] errorCodes = ["#DIV/0!", "#VALUE!", "#REF!", "#NAME?", "#NUM!", "#ERROR!"];

        foreach (var symbol in operators.Concat(functions))
            Assert.Contains(formulas, f => f.Contains(symbol, StringComparison.OrdinalIgnoreCase));
        foreach (var code in errorCodes)
            Assert.Contains(code, errors);
    }

    [Theory]
    [MemberData(nameof(Names))]
    public void Evaluates_to_the_expected_value(string name)
    {
        var (dims, byName) = File.Value;
        var vector = byName[name];

        var cells = new TestCells(dims);
        if (vector.Cells.ValueKind == JsonValueKind.Object)
        {
            foreach (var cell in vector.Cells.EnumerateObject())
                cells.Value(cell.Name, ReadCell(cell.Value));
        }

        var actual = FormulaEvaluator.Evaluate(vector.Formula, cells);
        var expected = vector.Expected;

        switch (expected.GetProperty("type").GetString())
        {
            case "number":
                Assert.Equal(FormulaValue.FromNumber(expected.GetProperty("value").GetDouble()), actual);
                break;
            case "text":
                Assert.Equal(FormulaValue.FromText(expected.GetProperty("value").GetString()!), actual);
                break;
            case "boolean":
                Assert.Equal(FormulaValue.FromBoolean(expected.GetProperty("value").GetBoolean()), actual);
                break;
            case "error":
                Assert.Equal(expected.GetProperty("value").GetString(), actual.IsError ? actual.ToDisplayString() : actual.ToString());
                break;
            default:
                Assert.Fail($"unknown expected type in vector '{name}'");
                break;
        }

        if (expected.TryGetProperty("display", out var display))
            Assert.Equal(display.GetString(), actual.ToDisplayString());
    }

    private static FormulaValue ReadCell(JsonElement cell) => cell.ValueKind switch
    {
        JsonValueKind.Null => FormulaValue.Empty,
        JsonValueKind.String => FormulaValue.FromRaw(cell.GetString()),
        JsonValueKind.Object => FormulaValue.FromError(ErrorFromCode(cell.GetProperty("error").GetString()!)),
        _ => throw new InvalidOperationException($"unsupported cell in vectors: {cell}"),
    };

    private static FormulaError ErrorFromCode(string code) =>
        Enum.GetValues<FormulaError>().Single(e => FormulaValue.ErrorCode(e) == code);
}
