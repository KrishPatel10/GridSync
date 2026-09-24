using GridSync.Core.Rows;

namespace GridSync.Core;

/// <summary>
/// "Set the cell in row <see cref="RowId"/>, column <see cref="Col"/> to Value", stamped with the HLC
/// time it was made. A null Value means the cell was cleared. Clears are kept as tombstones rather
/// than deleted, otherwise an offline replica holding an older value would bring it back to life.
/// </summary>
/// <remarks>
/// Cells are addressed by a stable row id, not a row number, because row numbers move when someone
/// inserts a row. Serialized over SignalR as <c>{ rowId, col, value, ts }</c>, matching <c>CellOp</c>
/// in the client.
/// </remarks>
public sealed record CellOp(string RowId, int Col, string? Value, HlcTimestamp Ts);

/// <summary>
/// "A row with this id exists, and sorts at this key." Rows are never changed or removed once
/// created, so the set of rows is a grow-only set: merging two replicas' sets is a union, which is
/// commutative, associative and idempotent, the same properties the cell merge relies on.
/// </summary>
public sealed record RowOp(string RowId, string Key);

public readonly record struct CellKey(string RowId, int Col);

/// <summary>The current winning write for one cell.</summary>
public sealed record CellEntry(string? Value, HlcTimestamp Ts);

/// <summary>
/// <see cref="Rows"/> counts the rows a sheet starts with. Inserted rows come on top of that.
/// </summary>
public readonly record struct SheetDimensions(int Rows, int Cols);

/// <summary>
/// Row ids come in two kinds. The rows a sheet starts with are implicit (100,000 rows nobody has
/// touched are not worth storing), named "b0", "b1", and so on, with keys computed from the number.
/// Rows someone inserts get a random 32 digit lowercase hex id and a stored key.
/// </summary>
public static class RowIds
{
    public const int InsertedIdLength = 32;

    public static string ForBaseRow(int index) => "b" + index.ToString(System.Globalization.CultureInfo.InvariantCulture);

    /// <summary>True for "b0", "b17" and so on (no leading zeros, so each row has exactly one spelling).</summary>
    public static bool TryParseBaseRow(string id, out int index)
    {
        index = 0;
        if (id.Length < 2 || id.Length > 9 || id[0] != 'b') return false;
        if (id[1] == '0' && id.Length > 2) return false;
        for (var i = 1; i < id.Length; i++)
        {
            if (id[i] is < '0' or > '9') return false;
        }

        return int.TryParse(id.AsSpan(1), System.Globalization.NumberStyles.None, System.Globalization.CultureInfo.InvariantCulture, out index);
    }

    public static bool IsInsertedId(string id)
    {
        if (id.Length != InsertedIdLength) return false;
        foreach (var c in id)
        {
            if (c is not ((>= '0' and <= '9') or (>= 'a' and <= 'f'))) return false;
        }

        return true;
    }

    /// <summary>The sort key of a base row, used to order it among inserted rows.</summary>
    public static string BaseRowKey(int index) => FractionalIndex.ForBaseRow(index);
}
