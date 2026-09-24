using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace GridSync.Api.Tests.Persistence;

/// <summary>
/// Runs the real app (real Program.cs, real EF Core, real migrations, real SheetHub) against
/// SQLite instead of SQL Server. This is the closest this test suite can get to "does persistence
/// actually work end to end" without a SQL Server to talk to (see the README's persistence section
/// for why: this environment cannot reach the image registry SQL Server ships from). SQLite is a
/// different dialect, but the same GridSyncDbContext, the same EfPersistenceStore, the same
/// migrations, and the same restore logic run against it, which is everything this project's own
/// code is responsible for; the provider swap itself is EF Core's job, not this project's.
///
/// Sets GridSync:TestSqlitePath, which Program.cs checks for exactly this purpose: EF Core does
/// not support cleanly swapping a registered provider from a WebApplicationFactory
/// ConfigureServices hook (both providers' services end up registered at once and EF refuses to
/// pick one), so the provider is chosen once, in Program.cs, from configuration instead.
///
/// Give each instance its own SQLite file (a shared path is how two "restarts" of the app read
/// the same data). The file is not deleted here: tests that want a clean one on disposal do that
/// themselves, and tests proving persistence across a restart want it to survive disposal.
/// </summary>
public sealed class SqliteWebApplicationFactory(string databasePath) : WebApplicationFactory<Program>
{
    protected override void ConfigureWebHost(IWebHostBuilder builder) =>
        builder.UseSetting("GridSync:TestSqlitePath", databasePath);

    public static string NewTempDatabasePath() => Path.Combine(Path.GetTempPath(), $"gridsync-test-{Guid.NewGuid():N}.db");
}
