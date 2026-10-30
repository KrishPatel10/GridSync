using GridSync.Api.Sheets;
using GridSync.Core;
using Microsoft.Extensions.Options;

namespace GridSync.Api.Persistence;

/// <summary>
/// How many edits a sheet has had, so a page knows how far its history slider goes.
/// </summary>
public sealed record HistorySummary(int Count);

/// <summary>
/// The edit that produced a step: a cell edit (<see cref="Kind"/> "cell", with its value, null for a
/// clear, and its timestamp) or a row insert ("row", which the log stores without a timestamp or an author).
/// </summary>
public sealed record HistoryOp(string Kind, string RowId, int Col, string? Value, HlcTimestamp? Ts);

/// <summary>
/// The sheet as it stood after its first <paramref name="Step"/> logged edits. Same shape as what a
/// page gets on joining (initial row count, inserted rows, cells), minus cleared cells: a read-only
/// view has nothing to merge a tombstone against.
/// </summary>
public sealed record HistoryStep(
    int Step,
    int Count,
    int Rows,
    int Cols,
    IReadOnlyList<RowOp> InsertedRows,
    IReadOnlyList<CellOp> Cells,
    HistoryOp? Op);

/// <summary>
/// Version history, read from the op log that persistence already keeps. Nothing here writes, so it
/// cannot change a sheet, and the log is only ever appended to, so "after the first N edits" means
/// the same thing every time it is asked.
///
/// A step is a count of this sheet's logged edits, not an op Id: Ids are one sequence shared by every
/// sheet, so they have gaps within any one sheet. Only edits that won are logged (see SheetHub.ApplyOps),
/// so each step changes the sheet, and replaying them in log order through the same merge the hub
/// uses gives exactly what the people editing saw. The log is written behind the hub, so the newest
/// edit or two can be missing for a moment.
/// </summary>
public static class HistoryEndpoints
{
    public static void MapHistory(this IEndpointRouteBuilder app)
    {
        var history = app.MapGroup("/api/sheets/{id}/history");

        history.MapGet("", async (string id, IPersistenceStore store, CancellationToken ct) =>
            IdSyntax.IsValid(id)
                ? Results.Ok(new HistorySummary(await store.CountLogAsync(id, ct)))
                : BadId());

        history.MapGet("{step:int}", async (
            string id, int step, IPersistenceStore store, IOptions<GridSyncOptions> options, CancellationToken ct) =>
        {
            if (!IdSyntax.IsValid(id)) return BadId();

            var count = await store.CountLogAsync(id, ct);
            if (step < 0 || step > count)
                return Results.Problem($"Step must be between 0 and {count} for this sheet.", statusCode: StatusCodes.Status400BadRequest);

            // ponytail: replays the log from the start on every request, O(step). Fine for a demo-sized
            // log. When it isn't: start from the stored snapshot when its UpToOpId is at or before the
            // step, and replay only the entries after it (see SheetRestorer).
            var prefix = await store.GetLogPrefixAsync(id, step, ct);
            var dims = options.Value.Dimensions;
            var sheet = SheetRestorer.Restore(id, dims, snapshot: null, prefix);

            var op = prefix.Count == 0 ? null : ToHistoryOp(prefix[^1]);
            var cells = sheet.Snapshot().Where(c => c.Value is not null).ToList();
            return Results.Ok(new HistoryStep(step, count, dims.Rows, dims.Cols, sheet.RowSnapshot(), cells, op));
        });
    }

    private static IResult BadId() =>
        Results.Problem("Sheet names can use 1 to 64 letters, digits, hyphens, or underscores.", statusCode: StatusCodes.Status400BadRequest);

    private static HistoryOp ToHistoryOp(OpLogEntry entry) =>
        entry.RowKey is not null
            ? new HistoryOp("row", entry.RowId, 0, null, null)
            : new HistoryOp("cell", entry.RowId, entry.Col, entry.Value, new HlcTimestamp(entry.WallMs, entry.Counter, entry.NodeId));
}
