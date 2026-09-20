namespace GridSync.Core.Tests;

public class HybridLogicalClockTests
{
    private static readonly DateTimeOffset T0 = new(2026, 9, 20, 12, 0, 0, TimeSpan.Zero);

    [Fact]
    public void Tick_is_strictly_increasing_when_the_physical_clock_stands_still()
    {
        var clock = new HybridLogicalClock("a", new ManualTimeProvider(T0));

        var first = clock.Tick();
        var second = clock.Tick();
        var third = clock.Tick();

        Assert.True(second > first);
        Assert.True(third > second);
        Assert.Equal(first.WallMs, third.WallMs);
    }

    [Fact]
    public void Tick_is_strictly_increasing_when_the_physical_clock_goes_backwards()
    {
        var time = new ManualTimeProvider(T0);
        var clock = new HybridLogicalClock("a", time);

        var before = clock.Tick();
        time.Advance(TimeSpan.FromSeconds(-30)); // NTP correction, VM resume, etc.
        var after = clock.Tick();

        Assert.True(after > before);
    }

    [Fact]
    public void A_write_made_after_seeing_a_remote_write_sorts_after_it_even_with_a_slow_local_clock()
    {
        // Bob's laptop runs 2 minutes behind Alice's.
        var alice = new HybridLogicalClock("alice", new ManualTimeProvider(T0));
        var bob = new HybridLogicalClock("bob", new ManualTimeProvider(T0.AddMinutes(-2)));

        var aliceWrite = alice.Tick();
        bob.Receive(aliceWrite);   // Bob sees Alice's edit...
        var bobWrite = bob.Tick(); // ...then overwrites it.

        Assert.True(bobWrite > aliceWrite); // Bob's intent wins, despite his clock.
    }

    [Fact]
    public void Timestamps_with_equal_time_and_counter_are_ordered_by_node_id()
    {
        var a = new HlcTimestamp(1_000, 3, "node-a");
        var b = new HlcTimestamp(1_000, 3, "node-b");

        Assert.True(b > a);
        Assert.True(a < b);
        Assert.Equal(0, a.CompareTo(a));
    }
}
