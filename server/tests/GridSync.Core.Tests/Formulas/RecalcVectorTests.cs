using System.Text.Json;
using GridSync.Core.Formulas;

namespace GridSync.Core.Tests.Formulas;

/// <summary>
/// Replays spec/recalc-vectors.json, the file the TypeScript calculator's tests replay too. Each
/// scenario is a series of edits; after each one the results, the number of formulas evaluated,
/// and the updates reported must all match.
/// </summary>
public class RecalcVectorTests
{
    private sealed record Scenario(string Name, SheetDimensions Dimensions, JsonElement Steps);

    private static readonly Lazy<Dictionary<string, Scenario>> File = new(Load);

    public static IEnumerable<object[]> Names() => File.Value.Keys.Select(name => new object[] { name });

    private static Dictionary<string, Scenario> Load()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "recalc-vectors.json");
        using var doc = JsonDocument.Parse(System.IO.File.ReadAllText(path));

        var defaultSheet = ReadDimensions(doc.RootElement.GetProperty("sheet"));
        var scenarios = new Dictionary<string, Scenario>();
        foreach (var element in doc.RootElement.GetProperty("scenarios").EnumerateArray())
        {
            var name = element.GetProperty("name").GetString()!;
            var dims = element.TryGetProperty("sheet", out var sheet) ? ReadDimensions(sheet) : defaultSheet;
            Assert.True(scenarios.TryAdd(name, new Scenario(name, dims, element.GetProperty("steps").Clone())), $"duplicate scenario name: {name}");
        }
        return scenarios;
    }

    private static SheetDimensions ReadDimensions(JsonElement element) =>
        new(element.GetProperty("rows").GetInt32(), element.GetProperty("cols").GetInt32());

    [Fact]
    public void The_scenario_file_covers_the_important_behaviours() =>
        Assert.True(File.Value.Count >= 20, $"only {File.Value.Count} scenarios");

    [Theory]
    [MemberData(nameof(Names))]
    public void Replays_the_scenario(string name)
    {
        var scenario = File.Value[name];
        var calc = new SheetCalculator();
        calc.SetDimensions(scenario.Dimensions.Rows, scenario.Dimensions.Cols);
        var raws = new Dictionary<string, string?>();

        var stepNumber = 0;
        foreach (var step in scenario.Steps.EnumerateArray())
        {
            stepNumber++;
            var where = $"scenario '{name}', step {stepNumber}";
            var evaluatedBefore = calc.EvaluationCount;
            IReadOnlyList<FormulaUpdate> updates;

            if (step.TryGetProperty("set", out var set))
            {
                var changes = new List<RawChange>();
                foreach (var cell in set.EnumerateObject())
                {
                    Assert.True(CellAddress.TryParse(cell.Name, out var row, out var col), $"bad address {cell.Name}");
                    var raw = cell.Value.ValueKind == JsonValueKind.Null ? null : cell.Value.GetString();
                    raws[cell.Name] = raw;
                    changes.Add(new RawChange(row, col, raw));
                }
                updates = calc.ApplyChanges(changes);
            }
            else
            {
                updates = calc.SetDimensions(
                    step.GetProperty("dimensions").GetProperty("rows").GetInt32(),
                    step.GetProperty("dimensions").GetProperty("cols").GetInt32());
            }

            foreach (var expected in step.GetProperty("expect").EnumerateObject())
            {
                Assert.True(CellAddress.TryParse(expected.Name, out var row, out var col), $"bad address {expected.Name}");
                var shown = calc.FormulaDisplayAt(row, col) ?? raws.GetValueOrDefault(expected.Name) ?? string.Empty;
                Assert.True(expected.Value.GetString() == shown, $"{where}: {expected.Name} shows '{shown}', expected '{expected.Value.GetString()}'");
            }

            if (step.TryGetProperty("evaluated", out var evaluated))
                Assert.Equal(evaluated.GetInt64(), calc.EvaluationCount - evaluatedBefore);

            if (step.TryGetProperty("updates", out var expectedUpdates))
            {
                var expectedMap = expectedUpdates.EnumerateObject().ToDictionary(
                    p => p.Name,
                    p => p.Value.ValueKind == JsonValueKind.Null ? null : p.Value.GetString());
                var actualMap = updates.ToDictionary(
                    u => CellAddress.ToA1(SheetCalculator.RowOf(u.Key), SheetCalculator.ColOf(u.Key)),
                    u => u.Display);

                Assert.True(
                    expectedMap.Count == actualMap.Count && expectedMap.All(e => actualMap.TryGetValue(e.Key, out var d) && d == e.Value),
                    $"{where}: updates were [{Describe(actualMap)}], expected [{Describe(expectedMap)}]");
            }
        }
    }

    private static string Describe(Dictionary<string, string?> map) =>
        string.Join(", ", map.OrderBy(e => e.Key, StringComparer.Ordinal).Select(e => $"{e.Key}={e.Value ?? "null"}"));
}
