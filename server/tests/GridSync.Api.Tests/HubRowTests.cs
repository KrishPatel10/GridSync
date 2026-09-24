using GridSync.Api.Hubs;
using GridSync.Core;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.AspNetCore.SignalR;
using Microsoft.AspNetCore.SignalR.Client;

namespace GridSync.Api.Tests;

/// <summary>Row inserts through the real hub: what gets accepted, rejected and broadcast.</summary>
public class HubRowTests
{
    private const string NewRow = "0123456789abcdef0123456789abcdef";

    private static WebApplicationFactory<Program> NewApp() =>
        new WebApplicationFactory<Program>().WithWebHostBuilder(b => b.UseSetting("ConnectionStrings:GridSync", string.Empty));

    private static async Task<HubConnection> JoinAsync(WebApplicationFactory<Program> app, string node, int protocol = Protocol.Version)
    {
        var client = app.CreateClient();
        var connection = new HubConnectionBuilder()
            .WithUrl(new Uri(client.BaseAddress!, "/hubs/sheet"), o => o.HttpMessageHandlerFactory = _ => app.Server.CreateHandler())
            .Build();
        await connection.StartAsync();
        await connection.InvokeAsync<JoinResult>("JoinSheet", "demo", node, node, "#112233", protocol);
        return connection;
    }

    private static CellOp Cell(string rowId, string value, string node = "node-a") =>
        new(rowId, 0, value, new HlcTimestamp(1, 0, node));

    [Fact]
    public async Task A_row_and_a_cell_in_it_reach_the_other_client_in_one_broadcast()
    {
        await using var app = NewApp();
        await using var a = await JoinAsync(app, "node-a");
        await using var b = await JoinAsync(app, "node-b");

        var received = new TaskCompletionSource<(RowOp[] Rows, CellOp[] Cells)>();
        b.On<RowOp[], CellOp[]>("OpsApplied", (rows, cells) => received.TrySetResult((rows, cells)));

        await a.InvokeAsync<ApplyResult>("ApplyOps", new RowOp?[] { new(NewRow, "0000k") }, new CellOp?[] { Cell(NewRow, "hi") });

        var (rows, cells) = await received.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal(new RowOp(NewRow, "0000k"), Assert.Single(rows));
        Assert.Equal("hi", Assert.Single(cells).Value);
    }

    [Fact]
    public async Task A_late_joiner_gets_the_inserted_rows_in_the_snapshot()
    {
        await using var app = NewApp();
        await using var a = await JoinAsync(app, "node-a");
        await a.InvokeAsync<ApplyResult>("ApplyOps", new RowOp?[] { new(NewRow, "0000k") }, Array.Empty<CellOp?>());

        await using var b = await JoinAsync(app, "node-b");
        var joined = await b.InvokeAsync<JoinResult>("JoinSheet", "demo", "node-b", "node-b", "#112233", Protocol.Version);

        Assert.Equal(new RowOp(NewRow, "0000k"), Assert.Single(joined.InsertedRows));
    }

    [Fact]
    public async Task An_edit_in_a_row_that_does_not_exist_is_rejected()
    {
        await using var app = NewApp();
        await using var a = await JoinAsync(app, "node-a");

        var result = await a.InvokeAsync<ApplyResult>("ApplyOps", Array.Empty<RowOp?>(), new CellOp?[] { Cell(NewRow, "orphan") });

        Assert.Equal(0, result.Accepted);
        Assert.Equal("UnknownRow", Assert.Single(result.Rejected).Reason);
    }

    [Fact]
    public async Task Rejections_are_numbered_across_rows_then_cells()
    {
        await using var app = NewApp();
        await using var a = await JoinAsync(app, "node-a");

        var result = await a.InvokeAsync<ApplyResult>(
            "ApplyOps",
            new RowOp?[] { new(NewRow, "0000k"), new("b5", "V") },   // the second is not a valid inserted row
            new CellOp?[] { Cell(NewRow, "ok"), Cell("b1000000", "bad") });

        Assert.Equal(2, result.Accepted);
        Assert.Equal([1, 3], result.Rejected.Select(r => r.Index).ToArray());
    }

    [Fact]
    public async Task Sending_a_row_the_sheet_already_has_is_not_an_error_and_not_broadcast_again()
    {
        await using var app = NewApp();
        await using var a = await JoinAsync(app, "node-a");
        await a.InvokeAsync<ApplyResult>("ApplyOps", new RowOp?[] { new(NewRow, "0000k") }, Array.Empty<CellOp?>());

        var again = await a.InvokeAsync<ApplyResult>("ApplyOps", new RowOp?[] { new(NewRow, "0000k") }, Array.Empty<CellOp?>());

        Assert.Equal(0, again.Accepted);
        Assert.Equal(1, again.Stale);
        Assert.Empty(again.Rejected);
    }

    [Fact]
    public async Task A_page_speaking_another_protocol_version_is_told_to_reload()
    {
        await using var app = NewApp();

        var ex = await Assert.ThrowsAsync<HubException>(() => JoinAsync(app, "node-a", protocol: Protocol.Version - 1));

        Assert.Contains("out of date", ex.Message);
    }

    [Fact]
    public async Task Presence_names_the_row_by_id_so_it_follows_the_row_when_rows_are_inserted()
    {
        await using var app = NewApp();
        await using var a = await JoinAsync(app, "node-a");
        await using var b = await JoinAsync(app, "node-b");

        var seen = new TaskCompletionSource<UserPresenceDto>();
        b.On<UserPresenceDto>("PresenceChanged", p => { if (p.RowId is not null) seen.TrySetResult(p); });

        await a.SendAsync("SelectCell", "b7", 2);

        var presence = await seen.Task.WaitAsync(TimeSpan.FromSeconds(5));
        Assert.Equal("b7", presence.RowId);
        Assert.Equal(2, presence.Col);
    }

    private sealed record UserPresenceDto(string ConnectionId, string NodeId, string Name, string Color, string? RowId, int? Col);
}
