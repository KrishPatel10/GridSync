using Microsoft.EntityFrameworkCore;

namespace GridSync.Api.Persistence;

/// <summary>
/// The real store, backed by SQL Server through EF Core. Takes a context factory rather than a
/// context: this is used from singletons (SheetStore, the two background services), and a
/// DbContext is not safe to share across concurrent calls, so every method here opens and
/// disposes its own short-lived one.
/// </summary>
public sealed class EfPersistenceStore(IDbContextFactory<GridSyncDbContext> factory) : IPersistenceStore
{
    public async Task AppendAsync(IReadOnlyList<OpLogEntry> batch, CancellationToken ct = default)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        db.OpLog.AddRange(batch);
        await db.SaveChangesAsync(ct);
    }

    public async Task<SheetSnapshot?> GetSnapshotAsync(string sheetId, CancellationToken ct = default)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.Snapshots.AsNoTracking().SingleOrDefaultAsync(s => s.SheetId == sheetId, ct);
    }

    public async Task<IReadOnlyList<OpLogEntry>> GetTailAsync(string sheetId, long afterOpId, CancellationToken ct = default)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.OpLog.AsNoTracking()
            .Where(e => e.SheetId == sheetId && e.Id > afterOpId)
            .OrderBy(e => e.Id)
            .ToListAsync(ct);
    }

    public async Task<long> GetLatestOpIdAsync(string sheetId, CancellationToken ct = default)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        return await db.OpLog.AsNoTracking()
            .Where(e => e.SheetId == sheetId)
            .Select(e => (long?)e.Id)
            .MaxAsync(ct) ?? 0;
    }

    public async Task SaveSnapshotAsync(SheetSnapshot snapshot, CancellationToken ct = default)
    {
        await using var db = await factory.CreateDbContextAsync(ct);
        // One row per sheet: upsert, not insert. SQL Server's MERGE-free way to do this in EF Core
        // is "try update, insert if that touched nothing" using ExecuteUpdate, which needs no
        // round trip to check existence first.
        var updated = await db.Snapshots
            .Where(s => s.SheetId == snapshot.SheetId)
            .ExecuteUpdateAsync(set => set
                .SetProperty(s => s.CellsJson, snapshot.CellsJson)
                .SetProperty(s => s.UpToOpId, snapshot.UpToOpId)
                .SetProperty(s => s.WrittenAtUtc, snapshot.WrittenAtUtc), ct);

        if (updated == 0)
        {
            db.Snapshots.Add(snapshot);
            try
            {
                await db.SaveChangesAsync(ct);
            }
            catch (DbUpdateException)
            {
                // Lost a race with another writer that inserted the same sheet's first snapshot
                // between our update attempt and this insert. Their snapshot is fine to keep;
                // there is nothing in ours that matters more than what's already there.
            }
        }
    }
}
