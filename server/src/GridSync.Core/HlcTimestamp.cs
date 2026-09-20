namespace GridSync.Core;

/// <summary>
/// A Hybrid Logical Clock timestamp. Ordering is (WallMs, Counter, NodeId), which gives a
/// total order across all replicas: two different writes can never compare as equal, so
/// every replica picks the same winner without asking anyone else.
/// </summary>
/// <remarks>
/// The TypeScript client implements the identical comparison in <c>hlc.ts</c>. If you change
/// the ordering here, change it there too, or replicas will stop converging.
/// </remarks>
public readonly record struct HlcTimestamp(long WallMs, int Counter, string NodeId)
    : IComparable<HlcTimestamp>
{
    public int CompareTo(HlcTimestamp other)
    {
        var byWall = WallMs.CompareTo(other.WallMs);
        if (byWall != 0) return byWall;

        var byCounter = Counter.CompareTo(other.Counter);
        if (byCounter != 0) return byCounter;

        // Ordinal comparison matches JavaScript's default string comparison (UTF-16 code units).
        return string.CompareOrdinal(NodeId, other.NodeId);
    }

    public static bool operator >(HlcTimestamp left, HlcTimestamp right) => left.CompareTo(right) > 0;
    public static bool operator <(HlcTimestamp left, HlcTimestamp right) => left.CompareTo(right) < 0;
    public static bool operator >=(HlcTimestamp left, HlcTimestamp right) => left.CompareTo(right) >= 0;
    public static bool operator <=(HlcTimestamp left, HlcTimestamp right) => left.CompareTo(right) <= 0;

    public override string ToString() => $"{WallMs}:{Counter}:{NodeId}";
}
