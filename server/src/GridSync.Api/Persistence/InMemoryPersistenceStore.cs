namespace GridSync.Api.Persistence;

/// <summary>
/// Stands in for the database in tests: the same durability contract, kept in memory. Also usable
/// as a real (if non-durable) fallback if a deployment has no database configured.
/// </summary>
public sealed class InMemoryPersistenceStore : IPersistenceStore
{
    private readonly object _gate = new();
    private readonly List<OpLogEntry> _log = [];
    private readonly Dictionary<string, SheetSnapshot> _snapshots = [];
    private long _nextId = 1;

    public Task AppendAsync(IReadOnlyList<OpLogEntry> batch, CancellationToken ct = default)
    {
        lock (_gate)
        {
            foreach (var entry in batch)
            {
                entry.Id = _nextId++;
                _log.Add(entry);
            }
        }
        return Task.CompletedTask;
    }

    public Task<SheetSnapshot?> GetSnapshotAsync(string sheetId, CancellationToken ct = default)
    {
        lock (_gate)
        {
            return Task.FromResult(_snapshots.GetValueOrDefault(sheetId));
        }
    }

    public Task<IReadOnlyList<OpLogEntry>> GetTailAsync(string sheetId, long afterOpId, CancellationToken ct = default)
    {
        lock (_gate)
        {
            IReadOnlyList<OpLogEntry> tail = _log
                .Where(e => e.SheetId == sheetId && e.Id > afterOpId)
                .OrderBy(e => e.Id)
                .ToList();
            return Task.FromResult(tail);
        }
    }

    public Task<long> GetLatestOpIdAsync(string sheetId, CancellationToken ct = default)
    {
        lock (_gate)
        {
            var latest = _log.Where(e => e.SheetId == sheetId).Select(e => e.Id).DefaultIfEmpty(0).Max();
            return Task.FromResult(latest);
        }
    }

    public Task SaveSnapshotAsync(SheetSnapshot snapshot, CancellationToken ct = default)
    {
        lock (_gate)
        {
            _snapshots[snapshot.SheetId] = snapshot;
        }
        return Task.CompletedTask;
    }
}
