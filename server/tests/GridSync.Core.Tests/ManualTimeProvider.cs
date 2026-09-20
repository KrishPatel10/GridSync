namespace GridSync.Core.Tests;

/// <summary>A clock the test controls. Lets us simulate skewed, frozen, or backwards clocks.</summary>
internal sealed class ManualTimeProvider(DateTimeOffset start) : TimeProvider
{
    public DateTimeOffset Now { get; set; } = start;

    public override DateTimeOffset GetUtcNow() => Now;

    public void Advance(TimeSpan by) => Now = Now.Add(by);
}
