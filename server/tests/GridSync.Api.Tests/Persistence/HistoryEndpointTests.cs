using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using GridSync.Api.Hubs;
using GridSync.Core;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR.Client;

namespace GridSync.Api.Tests.Persistence;

/// <summary>
/// Version history through the real app: edits go in through the hub, are written behind to SQLite,
/// and come back out of the history endpoints. Asserts on the JSON itself (property names and all)
/// rather than on deserialized C# types, because the browser reads the JSON.
/// </summary>
public class HistoryEndpointTests : IAsyncLifetime
{
    private const string NewRow = "0123456789abcdef0123456789abcdef";
    private string _dbPath = null!;

    public Task InitializeAsync()
    {
        _dbPath = SqliteWebApplicationFactory.NewTempDatabasePath();
        return Task.CompletedTask;
    }

    public Task DisposeAsync()
    {
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try
        {
            File.Delete(_dbPath);
        }
        catch (IOException)
        {
            // A temp file left behind on a rare failure to delete it is harmless.
        }
        return Task.CompletedTask;
    }

    private static CellOp Op(int row, int col, string? value, long wallMs) =>
        new(RowIds.ForBaseRow(row), col, value, new HlcTimestamp(wallMs, 0, "node-a"));

    private static async Task<HubConnection> ConnectAsync(WebApplicationFactory<Program> app)
    {
        var client = app.CreateClient();
        var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(client.BaseAddress!, "/hubs/sheet"), o => o.HttpMessageHandlerFactory = _ => app.Server.CreateHandler())
            .Build();
        await connection.StartAsync();
        return connection;
    }

    /// <summary>Waits until the write-behind log has caught up, by asking the endpoint under test.</summary>
    private static async Task WaitForCountAsync(HttpClient http, string sheetId, int count)
    {
        var deadline = DateTime.UtcNow + TimeSpan.FromSeconds(10);
        while (DateTime.UtcNow < deadline)
        {
            var summary = await http.GetFromJsonAsync<JsonElement>($"/api/sheets/{sheetId}/history");
            if (summary.GetProperty("count").GetInt32() >= count) return;
            await Task.Delay(50);
        }
        Assert.Fail($"Timed out waiting for {count} logged edits");
    }

    [Fact]
    public async Task Replays_the_log_one_edit_at_a_time()
    {
        await using var app = new SqliteWebApplicationFactory(_dbPath);
        await using var connection = await ConnectAsync(app);
        using var http = app.CreateClient();

        await connection.InvokeAsync<JoinResult>("JoinSheet", "demo", "node-a", "Alice", "#112233", Protocol.Version);
        async Task Apply(RowOp?[] rows, CellOp?[] cells) => await connection.InvokeAsync<ApplyResult>("ApplyOps", rows, cells);

        await Apply([], [Op(0, 0, "one", 1)]);                              // step 1
        await Apply([], [Op(0, 0, "two", 2)]);                              // step 2
        var stale = await connection.InvokeAsync<ApplyResult>("ApplyOps", Array.Empty<RowOp?>(), new CellOp?[] { Op(0, 0, "stale", 1) });
        Assert.Equal(1, stale.Stale);                                       // lost to "two": never logged, so not a step
        await Apply([], [Op(1, 0, "second row", 3)]);                       // step 3
        await Apply([new RowOp(NewRow, "0000k")], []);                      // step 4
        await Apply([], [Op(0, 0, null, 4)]);                               // step 5: clears A1

        await WaitForCountAsync(http, "demo", 5);

        var summary = await http.GetFromJsonAsync<JsonElement>("/api/sheets/demo/history");
        Assert.Equal(5, summary.GetProperty("count").GetInt32());

        var start = await http.GetFromJsonAsync<JsonElement>("/api/sheets/demo/history/0");
        Assert.Equal(0, start.GetProperty("cells").GetArrayLength());
        Assert.Equal(JsonValueKind.Null, start.GetProperty("op").ValueKind);
        Assert.Equal(100_000, start.GetProperty("rows").GetInt32());
        Assert.Equal(26, start.GetProperty("cols").GetInt32());

        var one = await http.GetFromJsonAsync<JsonElement>("/api/sheets/demo/history/1");
        Assert.Equal("one", one.GetProperty("cells")[0].GetProperty("value").GetString());
        Assert.Equal("cell", one.GetProperty("op").GetProperty("kind").GetString());
        Assert.Equal("node-a", one.GetProperty("op").GetProperty("ts").GetProperty("nodeId").GetString());
        Assert.Equal(1, one.GetProperty("op").GetProperty("ts").GetProperty("wallMs").GetInt64());

        var two = await http.GetFromJsonAsync<JsonElement>("/api/sheets/demo/history/2");
        Assert.Equal("two", Assert.Single(two.GetProperty("cells").EnumerateArray()).GetProperty("value").GetString());

        var third = await http.GetFromJsonAsync<JsonElement>("/api/sheets/demo/history/3");
        Assert.Equal(2, third.GetProperty("cells").GetArrayLength());

        var rowInserted = await http.GetFromJsonAsync<JsonElement>("/api/sheets/demo/history/4");
        Assert.Equal(NewRow, Assert.Single(rowInserted.GetProperty("insertedRows").EnumerateArray()).GetProperty("rowId").GetString());
        Assert.Equal("row", rowInserted.GetProperty("op").GetProperty("kind").GetString());
        Assert.Equal(JsonValueKind.Null, rowInserted.GetProperty("op").GetProperty("ts").ValueKind);

        // A cleared cell is gone from the cells list, and the sheet before the clear still had it.
        var cleared = await http.GetFromJsonAsync<JsonElement>("/api/sheets/demo/history/5");
        var left = Assert.Single(cleared.GetProperty("cells").EnumerateArray());
        Assert.Equal("b1", left.GetProperty("rowId").GetString());
        Assert.Equal(JsonValueKind.Null, cleared.GetProperty("op").GetProperty("value").ValueKind);
        Assert.Equal(5, cleared.GetProperty("count").GetInt32());
    }

    [Fact]
    public async Task A_sheet_with_no_edits_has_an_empty_history()
    {
        await using var app = new SqliteWebApplicationFactory(_dbPath);
        using var http = app.CreateClient();

        var summary = await http.GetFromJsonAsync<JsonElement>("/api/sheets/never-edited/history");
        Assert.Equal(0, summary.GetProperty("count").GetInt32());

        var start = await http.GetFromJsonAsync<JsonElement>("/api/sheets/never-edited/history/0");
        Assert.Equal(0, start.GetProperty("cells").GetArrayLength());
    }

    [Theory]
    [InlineData("/api/sheets/demo/history/-1")]
    [InlineData("/api/sheets/demo/history/1")] // the sheet has no edits, so step 1 does not exist yet
    [InlineData("/api/sheets/bad%20name/history")]
    [InlineData("/api/sheets/bad%20name/history/0")]
    public async Task Rejects_a_step_that_does_not_exist_and_a_name_the_hub_would_refuse(string url)
    {
        await using var app = new SqliteWebApplicationFactory(_dbPath);
        using var http = app.CreateClient();

        var response = await http.GetAsync(url);

        Assert.Equal(HttpStatusCode.BadRequest, response.StatusCode);
    }
}
