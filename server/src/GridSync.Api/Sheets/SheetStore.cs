using System.Collections.Concurrent;
using GridSync.Api.Persistence;
using GridSync.Core;
using Microsoft.Extensions.Options;

namespace GridSync.Api.Sheets;

/// <summary>
/// Holds every open sheet in memory. A sheet's first request in this process restores it from
/// persistence (see <see cref="Persistence.SheetRestorer"/>) rather than starting it empty, so a
/// server restart loses no acknowledged edit; after that it lives here for as long as the process
/// runs, same as phase 1.
/// </summary>
public sealed class SheetStore(IOptions<GridSyncOptions> options, IPersistenceStore persistence)
{
    private readonly ConcurrentDictionary<string, SheetState> _sheets = new(StringComparer.Ordinal);
    private readonly ConcurrentDictionary<string, Task<SheetState>> _restoring = new(StringComparer.Ordinal);
    private readonly GridSyncOptions _options = options.Value;

    public int Count => _sheets.Count;

    /// <summary>Every sheet currently loaded in memory. Used by the snapshot service; order is not meaningful.</summary>
    public IReadOnlyCollection<SheetState> All => (IReadOnlyCollection<SheetState>)_sheets.Values;

    public SheetState? Find(string id) => _sheets.TryGetValue(id, out var sheet) ? sheet : null;

    /// <exception cref="SheetLimitReachedException">When creating a new sheet would exceed MaxSheets.</exception>
    public async Task<SheetState> GetOrCreateAsync(string id, CancellationToken ct = default)
    {
        if (_sheets.TryGetValue(id, out var existing)) return existing;

        // Soft cap: under a burst of concurrent creates this can overshoot by a few sheets,
        // which is fine for a memory guard and avoids a global lock on the hot path.
        if (_sheets.Count >= _options.MaxSheets) throw new SheetLimitReachedException(_options.MaxSheets);

        // Several joins can race to open the same never-before-seen sheet; only one of them
        // should hit the database. The rest await that one restore instead of each doing their own.
        var restore = _restoring.GetOrAdd(id, key => SheetRestorer.RestoreAsync(persistence, key, _options.Dimensions, ct));
        try
        {
            var sheet = await restore;
            return _sheets.GetOrAdd(id, sheet);
        }
        finally
        {
            _restoring.TryRemove(id, out _);
        }
    }
}

public sealed class SheetLimitReachedException(int max)
    : InvalidOperationException($"This server already holds its limit of {max} sheets.");
