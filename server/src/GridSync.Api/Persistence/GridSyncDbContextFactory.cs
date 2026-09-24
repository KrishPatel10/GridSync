using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Design;

namespace GridSync.Api.Persistence;

/// <summary>
/// Lets `dotnet ef migrations add` construct a GridSyncDbContext without running the app (and
/// without a real connection string: generating a migration only needs the model, never a live
/// database). Program.cs registers the context differently, with the real connection string from
/// configuration; this is design-time only.
/// </summary>
public sealed class GridSyncDbContextFactory : IDesignTimeDbContextFactory<GridSyncDbContext>
{
    public GridSyncDbContext CreateDbContext(string[] args)
    {
        var options = new DbContextOptionsBuilder<GridSyncDbContext>()
            .UseSqlServer("Server=.;Database=GridSync;Trusted_Connection=True;")
            .Options;
        return new GridSyncDbContext(options);
    }
}
