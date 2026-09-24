namespace GridSync.Api.Persistence;

/// <summary>
/// Where the op log and snapshots live. A thin interface, the same reason the client's
/// OutboxStorage is one: tests run against an in-memory fake (<see cref="InMemoryPersistenceStore"/>),
/// production runs against SQL Server (<see cref="EfPersistenceStore"/>), and the logic that
/// decides what to read and write (write-behind batching, snapshot timing, restore) never has to
/// know which one it's talking to.
/// </summary>
public interface IPersistenceStore
{
    /// <summary>Appends a batch to the log. Entries are assigned Ids in the order given.</summary>
    Task AppendAsync(IReadOnlyList<OpLogEntry> batch, CancellationToken ct = default);

    Task<SheetSnapshot?> GetSnapshotAsync(string sheetId, CancellationToken ct = default);

    /// <summary>Log entries for a sheet after a given Id (0 for "the whole log"), oldest first.</summary>
    Task<IReadOnlyList<OpLogEntry>> GetTailAsync(string sheetId, long afterOpId, CancellationToken ct = default);

    /// <summary>The highest Id logged for a sheet, or 0 if it has never been written to.</summary>
    Task<long> GetLatestOpIdAsync(string sheetId, CancellationToken ct = default);

    /// <summary>Replaces this sheet's snapshot (there is only ever one, not a history).</summary>
    Task SaveSnapshotAsync(SheetSnapshot snapshot, CancellationToken ct = default);
}
