namespace GridSync.Core;

/// <summary>
/// Hybrid Logical Clock (Kulkarni et al., 2014).
///
/// Why not plain wall-clock time? If my laptop clock is 2 minutes behind yours, and I see your
/// edit and then overwrite it, a wall clock would say my edit is "older" and yours would win,
/// even though I clearly meant to replace it. An HLC fixes that: after <see cref="Receive"/>
/// sees your timestamp, my next <see cref="Tick"/> is guaranteed to be greater than it,
/// while still staying close to real time.
///
/// The same algorithm runs in the browser (<c>client/src/app/sync/hlc.ts</c>). The server uses
/// this class in tests and will use it for server-generated ops in later phases.
/// </summary>
public sealed class HybridLogicalClock
{
    private readonly TimeProvider _time;
    private readonly object _gate = new();
    private long _lastWallMs;
    private int _lastCounter;

    public HybridLogicalClock(string nodeId, TimeProvider? time = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(nodeId);
        NodeId = nodeId;
        _time = time ?? TimeProvider.System;
    }

    public string NodeId { get; }

    /// <summary>Returns a timestamp for a new local event, strictly greater than anything seen so far.</summary>
    public HlcTimestamp Tick()
    {
        lock (_gate)
        {
            var now = NowMs();
            if (now > _lastWallMs)
            {
                _lastWallMs = now;
                _lastCounter = 0;
            }
            else
            {
                // Physical clock hasn't moved forward (same millisecond, or it went backwards):
                // keep the logical time and bump the counter instead.
                _lastCounter = checked(_lastCounter + 1);
            }

            return new HlcTimestamp(_lastWallMs, _lastCounter, NodeId);
        }
    }

    /// <summary>Merges a timestamp observed from another replica, so our next Tick() sorts after it.</summary>
    public void Receive(HlcTimestamp remote)
    {
        lock (_gate)
        {
            var now = NowMs();
            var maxWall = Math.Max(now, Math.Max(_lastWallMs, remote.WallMs));

            int counter;
            if (maxWall == _lastWallMs && maxWall == remote.WallMs)
                counter = Math.Max(_lastCounter, remote.Counter) + 1;
            else if (maxWall == _lastWallMs)
                counter = _lastCounter + 1;
            else if (maxWall == remote.WallMs)
                counter = remote.Counter + 1;
            else
                counter = 0;

            _lastWallMs = maxWall;
            _lastCounter = counter;
        }
    }

    private long NowMs() => _time.GetUtcNow().ToUnixTimeMilliseconds();
}
