using Microsoft.EntityFrameworkCore;

namespace GridSync.Api.Persistence;

public sealed class GridSyncDbContext(DbContextOptions<GridSyncDbContext> options) : DbContext(options)
{
    public DbSet<OpLogEntry> OpLog => Set<OpLogEntry>();
    public DbSet<SheetSnapshot> Snapshots => Set<SheetSnapshot>();

    protected override void OnModelCreating(ModelBuilder modelBuilder)
    {
        modelBuilder.Entity<OpLogEntry>(op =>
        {
            op.HasKey(e => e.Id);
            op.Property(e => e.SheetId).HasMaxLength(64).IsRequired();
            op.Property(e => e.RowId).HasMaxLength(40).IsRequired();
            op.Property(e => e.RowKey).HasMaxLength(64);
            op.Property(e => e.NodeId).HasMaxLength(64).IsRequired();
            op.Property(e => e.Value).HasMaxLength(10_000);
            // Every read is "this sheet's entries after some Id", so that's the index that matters.
            op.HasIndex(e => new { e.SheetId, e.Id });
        });

        modelBuilder.Entity<SheetSnapshot>(snap =>
        {
            snap.HasKey(e => e.SheetId);
            snap.Property(e => e.SheetId).HasMaxLength(64);
            snap.Property(e => e.CellsJson).IsRequired();
            snap.Property(e => e.RowsJson).IsRequired();
        });
    }
}
