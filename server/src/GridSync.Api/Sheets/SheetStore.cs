using System.Collections.Concurrent;
using GridSync.Core;
using Microsoft.Extensions.Options;

namespace GridSync.Api.Sheets;

/// <summary>
/// Holds every open sheet in memory. Phase 1 keeps it simple: state resets when the server restarts.
/// Phase 3 replaces this with an append-only op log plus periodic snapshots.
/// </summary>
public sealed class SheetStore(IOptions<GridSyncOptions> options)
{
    private readonly ConcurrentDictionary<string, SheetState> _sheets = new(StringComparer.Ordinal);
    private readonly GridSyncOptions _options = options.Value;

    public int Count => _sheets.Count;

    public SheetState? Find(string id) => _sheets.TryGetValue(id, out var sheet) ? sheet : null;

    /// <exception cref="SheetLimitReachedException">When creating a new sheet would exceed MaxSheets.</exception>
    public SheetState GetOrCreate(string id)
    {
        if (_sheets.TryGetValue(id, out var existing)) return existing;

        // Soft cap: under a burst of concurrent creates this can overshoot by a few sheets,
        // which is fine for a memory guard and avoids a global lock on the hot path.
        if (_sheets.Count >= _options.MaxSheets) throw new SheetLimitReachedException(_options.MaxSheets);

        return _sheets.GetOrAdd(id, static (key, dims) => new SheetState(key, dims), _options.Dimensions);
    }
}

public sealed class SheetLimitReachedException(int max)
    : InvalidOperationException($"This server already holds its limit of {max} sheets.");
