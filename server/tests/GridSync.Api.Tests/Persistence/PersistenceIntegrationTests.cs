using GridSync.Api;
using GridSync.Api.Hubs;
using GridSync.Api.Persistence;
using GridSync.Api.Sheets;
using GridSync.Core;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR.Client;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Options;

namespace GridSync.Api.Tests.Persistence;

/// <summary>
/// The acceptance criterion from the brief, proven against a real app instance and a real
/// database: "a server restart loses no acknowledged edit." See SqliteWebApplicationFactory for
/// why SQLite stands in for SQL Server here.
/// </summary>
public class PersistenceIntegrationTests : IAsyncLifetime
{
    private string _dbPath = null!;

    public Task InitializeAsync()
    {
        _dbPath = SqliteWebApplicationFactory.NewTempDatabasePath();
        return Task.CompletedTask;
    }

    public Task DisposeAsync()
    {
        // Microsoft.Data.Sqlite pools native connections, so a handle to the file can outlive the
        // DbContext (and even the WebApplicationFactory) that used it.
        Microsoft.Data.Sqlite.SqliteConnection.ClearAllPools();
        try
        {
            File.Delete(_dbPath);
        }
        catch (IOException)
        {
            // Best-effort cleanup of a temp file; leaving one behind on a rare failure to delete
            // it is harmless and not worth failing the test over.
        }
        return Task.CompletedTask;
    }

    private SqliteWebApplicationFactory NewApp() => new(_dbPath);

    private static async Task<HubConnection> ConnectAsync(WebApplicationFactory<Program> app)
    {
        var client = app.CreateClient(); // also what actually starts the host
        var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(client.BaseAddress!, "/hubs/sheet"), o => o.HttpMessageHandlerFactory = _ => app.Server.CreateHandler())
            .Build();
        await connection.StartAsync();
        return connection;
    }

    // Every ApplyOps call in these tests happens on a connection joined as "node-a": the hub
    // rejects an op whose timestamp's node id does not match the node id its connection joined
    // with (see SheetHub.ApplyOps), so the default here must agree with the JoinSheet calls below.
    private static CellOp Op(int row, int col, string value, long wallMs, string node = "node-a") =>
        new(row, col, value, new HlcTimestamp(wallMs, 0, node));

    /// <summary>Polls the SQLite file directly (a fresh, independent connection) until N ops for a sheet are visible.</summary>
    private async Task WaitForLoggedAsync(string sheetId, int count, TimeSpan? timeout = null)
    {
        var deadline = DateTime.UtcNow + (timeout ?? TimeSpan.FromSeconds(10));
        while (DateTime.UtcNow < deadline)
        {
            await using var db = new GridSyncDbContext(new DbContextOptionsBuilder<GridSyncDbContext>().UseSqlite($"Data Source={_dbPath}").Options);
            if (await db.OpLog.CountAsync(e => e.SheetId == sheetId) >= count) return;
            await Task.Delay(50);
        }
        Assert.Fail($"Timed out waiting for {count} logged ops for '{sheetId}'");
    }

    [Fact]
    public async Task An_edit_is_visible_immediately_through_the_hub_before_a_restart()
    {
        await using var app = NewApp();
        await using var connection = await ConnectAsync(app);

        await connection.InvokeAsync<JoinResult>("JoinSheet", "demo", "node-a", "Alice", "#112233");
        var result = await connection.InvokeAsync<ApplyResult>("ApplyOps", new CellOp?[] { Op(0, 0, "hello", 1) });

        Assert.Equal(1, result.Accepted);
        Assert.Empty(result.Rejected);
    }

    [Fact]
    public async Task A_restart_restores_edits_that_had_reached_the_log()
    {
        await using (var app = NewApp())
        {
            await using var connection = await ConnectAsync(app);
            await connection.InvokeAsync<JoinResult>("JoinSheet", "demo", "node-a", "Alice", "#112233");
            await connection.InvokeAsync<ApplyResult>(
                "ApplyOps",
                new CellOp?[] { Op(0, 0, "survives a restart", 1), Op(1, 2, "so does this", 2) });

            await WaitForLoggedAsync("demo", count: 2); // let write-behind actually catch up
        }
        // app disposed: this is the "restart"

        await using var restarted = NewApp();
        await using var connection2 = await ConnectAsync(restarted);
        var joined = await connection2.InvokeAsync<JoinResult>("JoinSheet", "demo", "node-b", "Bob", "#445566");

        Assert.Contains(joined.Cells, c => c.Row == 0 && c.Col == 0 && c.Value == "survives a restart");
        Assert.Contains(joined.Cells, c => c.Row == 1 && c.Col == 2 && c.Value == "so does this");
    }

    [Fact]
    public async Task A_restart_restores_a_snapshot_and_the_tail_written_after_it_together()
    {
        await using (var app = NewApp())
        {
            await using var connection = await ConnectAsync(app);
            await connection.InvokeAsync<JoinResult>("JoinSheet", "demo", "node-a", "Alice", "#112233");

            // Default SnapshotEveryNOps (200) would never fire in a test; drive one directly so
            // this proves the snapshot-then-tail path, not only the tail-only path above.
            for (var i = 0; i < 3; i++)
                await connection.InvokeAsync<ApplyResult>("ApplyOps", new CellOp?[] { Op(0, i, $"snapshot-{i}", i + 1) });
            await WaitForLoggedAsync("demo", count: 3);

            // Force a snapshot directly rather than waiting on the real SnapshotService's timer
            // and configured threshold (200 by default): this test is about restore correctness,
            // not about when a snapshot happens (SnapshotServiceTests already covers that).
            using var scope = app.Services.CreateScope();
            var sheets = scope.ServiceProvider.GetRequiredService<SheetStore>();
            var store = scope.ServiceProvider.GetRequiredService<IPersistenceStore>();
            await store.SaveSnapshotAsync(SheetRestorer.ToSnapshot(sheets.Find("demo")!, await store.GetLatestOpIdAsync("demo"), TimeProvider.System));

            await connection.InvokeAsync<ApplyResult>("ApplyOps", new CellOp?[] { Op(1, 0, "after-the-snapshot", 10) });
            await WaitForLoggedAsync("demo", count: 4);
        }

        await using var restarted = NewApp();
        await using var connection2 = await ConnectAsync(restarted);
        var joined = await connection2.InvokeAsync<JoinResult>("JoinSheet", "demo", "node-b", "Bob", "#445566");

        Assert.Contains(joined.Cells, c => c.Row == 0 && c.Col == 0 && c.Value == "snapshot-0");
        Assert.Contains(joined.Cells, c => c.Row == 0 && c.Col == 2 && c.Value == "snapshot-2");
        Assert.Contains(joined.Cells, c => c.Row == 1 && c.Col == 0 && c.Value == "after-the-snapshot");
    }

    [Fact]
    public async Task Different_sheets_restore_independently()
    {
        await using (var app = NewApp())
        {
            await using var connection = await ConnectAsync(app);
            await connection.InvokeAsync<JoinResult>("JoinSheet", "sheet-one", "node-a", "Alice", "#112233");
            await connection.InvokeAsync<ApplyResult>("ApplyOps", new CellOp?[] { Op(0, 0, "one", 1) });

            await connection.InvokeAsync<JoinResult>("JoinSheet", "sheet-two", "node-a", "Alice", "#112233");
            await connection.InvokeAsync<ApplyResult>("ApplyOps", new CellOp?[] { Op(0, 0, "two", 1) });

            await WaitForLoggedAsync("sheet-one", 1);
            await WaitForLoggedAsync("sheet-two", 1);
        }

        await using var restarted = NewApp();
        await using var connection2 = await ConnectAsync(restarted);
        var one = await connection2.InvokeAsync<JoinResult>("JoinSheet", "sheet-one", "node-b", "Bob", "#445566");
        var two = await connection2.InvokeAsync<JoinResult>("JoinSheet", "sheet-two", "node-b", "Bob", "#445566");

        Assert.Single(one.Cells);
        Assert.Equal("one", one.Cells[0].Value);
        Assert.Single(two.Cells);
        Assert.Equal("two", two.Cells[0].Value);
    }

    [Fact]
    public async Task Runs_without_a_configured_database_using_the_in_memory_fallback()
    {
        // Explicitly empty, not just "whatever appsettings.Development.json happens to say":
        // that file points at the local docker-compose SQL Server for convenience when running
        // the app by hand, which is exactly what this test must not depend on.
        await using var app = new WebApplicationFactory<Program>()
            .WithWebHostBuilder(builder => builder.UseSetting("ConnectionStrings:GridSync", string.Empty));
        await using var connection = await ConnectAsync(app);

        await connection.InvokeAsync<JoinResult>("JoinSheet", "demo", "node-a", "Alice", "#112233");
        var result = await connection.InvokeAsync<ApplyResult>("ApplyOps", new CellOp?[] { Op(0, 0, "hello", 1) });

        Assert.Equal(1, result.Accepted);
    }
}
