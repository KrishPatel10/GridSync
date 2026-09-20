using GridSync.Api;
using GridSync.Api.Hubs;
using GridSync.Api.Sheets;
using GridSync.Core;
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

builder.Services.AddSignalR(o =>
{
    // The client caps each batch at ~256 KB, so this leaves headroom for JSON framing.
    o.MaximumReceiveMessageSize = 512 * 1024;
    o.EnableDetailedErrors = builder.Environment.IsDevelopment();
});

var app = builder.Build();

app.MapGet("/api/health", () => Results.Ok(new { status = "ok" }));

app.MapGet("/api/sheets/{id}", (string id, SheetStore store) =>
    store.Find(id) is { } sheet
        ? Results.Ok(new { sheet.Id, sheet.Dimensions.Rows, sheet.Dimensions.Cols, Filled = sheet.FilledCount })
        : Results.NotFound());

app.MapHub<SheetHub>("/hubs/sheet");

app.Run();

// Lets integration tests use WebApplicationFactory<Program> in a later phase.
public partial class Program;
