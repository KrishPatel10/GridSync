using GridSync.Api;
using GridSync.Api.Hubs;
using GridSync.Api.Persistence;
using GridSync.Api.Sheets;
using GridSync.Core;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Options;

var builder = WebApplication.CreateBuilder(args);

builder.Services
    .AddOptions<GridSyncOptions>()
    .Bind(builder.Configuration.GetSection(GridSyncOptions.Section))
    .ValidateDataAnnotations()
    .ValidateOnStart();

builder.Services.AddSingleton(TimeProvider.System);
builder.Services.AddSingleton(sp => sp.GetRequiredService<IOptions<GridSyncOptions>>().Value.ToLimits());
builder.Services.AddSingleton<OpValidator>();
builder.Services.AddSingleton<SheetStore>();
builder.Services.AddSingleton<PresenceTracker>();

// Persistence (phase 3): an append-only op log plus periodic snapshots, so a restart loses no
// acknowledged edit. Without a connection string, the server still runs, just as phase 1 did,
// on an in-memory store that does not survive a restart, rather than failing to start.
//
// GridSync:TestSqlitePath exists only for SqliteWebApplicationFactory (see GridSync.Api.Tests):
// EF Core does not support cleanly swapping a registered provider (SQL Server) for another
// (SQLite) from a WebApplicationFactory's ConfigureServices hook, because both providers' internal
// services end up registered at once and EF refuses to pick one. Choosing the provider once, here,
// from configuration avoids that: the test factory sets this key instead of trying to override the
// registration afterwards.
var connectionString = builder.Configuration.GetConnectionString("GridSync");
var testSqlitePath = builder.Configuration["GridSync:TestSqlitePath"];
var usingDatabase = !string.IsNullOrWhiteSpace(testSqlitePath) || !string.IsNullOrWhiteSpace(connectionString);

if (!string.IsNullOrWhiteSpace(testSqlitePath))
{
    builder.Services.AddDbContextFactory<GridSyncDbContext>(o => o.UseSqlite($"Data Source={testSqlitePath}"));
    builder.Services.AddSingleton<IPersistenceStore, EfPersistenceStore>();
}
else if (!string.IsNullOrWhiteSpace(connectionString))
{
    builder.Services.AddDbContextFactory<GridSyncDbContext>(o => o.UseSqlServer(connectionString));
    builder.Services.AddSingleton<IPersistenceStore, EfPersistenceStore>();
}
else
{
    builder.Services.AddSingleton<IPersistenceStore, InMemoryPersistenceStore>();
}

builder.Services.AddSingleton<OpLogChannel>();
builder.Services.AddHostedService<OpLogPersistenceService>();
builder.Services.AddHostedService<SnapshotService>();

builder.Services.AddSignalR(o =>
{
    // The client caps each batch at ~256 KB, so this leaves headroom for JSON framing.
    o.MaximumReceiveMessageSize = 512 * 1024;
    o.EnableDetailedErrors = builder.Environment.IsDevelopment();
});

var app = builder.Build();

if (usingDatabase)
{
    // If the database is configured but unreachable (wrong password, container still starting),
    // this throws and the app fails to start, which is what should happen: unlike a missing
    // connection string, a broken one is a real error, not an opt-out of persistence.
    var factory = app.Services.GetRequiredService<IDbContextFactory<GridSyncDbContext>>();
    await using var db = await factory.CreateDbContextAsync();

    if (!string.IsNullOrWhiteSpace(testSqlitePath))
    {
        // The test-only path: no migration history to maintain for a throwaway per-test file, and
        // the migrations were generated against SQL Server's conventions, which EF Core correctly
        // refuses to apply as-is against a different provider (PendingModelChangesWarning). Just
        // create the schema straight from the current model instead.
        await db.Database.EnsureCreatedAsync();
    }
    else
    {
        await db.Database.MigrateAsync();
    }
}

app.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));

app.MapGet("/api/sheets/{id}", (string id, SheetStore store) =>
    store.Find(id) is { } sheet
        ? Results.Ok(new { sheet.Id, sheet.Dimensions.Rows, sheet.Dimensions.Cols, Filled = sheet.FilledCount })
        : Results.NotFound());

app.MapHub<SheetHub>("/hubs/sheet");

app.Run();

// Lets GridSync.Api.Tests use WebApplicationFactory<Program>.
public partial class Program;
