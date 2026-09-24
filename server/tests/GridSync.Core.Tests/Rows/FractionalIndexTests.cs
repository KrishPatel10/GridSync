using System.Text.Json;
using FsCheck;
using FsCheck.Fluent;
using FsCheck.Xunit;
using GridSync.Core.Rows;

namespace GridSync.Core.Tests.Rows;

public class FractionalIndexTests
{
    private static readonly JsonElement Vectors = LoadVectors();

    private static JsonElement LoadVectors()
    {
        var path = Path.Combine(AppContext.BaseDirectory, "fractional-index-vectors.json");
        using var doc = JsonDocument.Parse(File.ReadAllText(path));
        return doc.RootElement.Clone();
    }

    private static string? Text(JsonElement element, string name) =>
        element.GetProperty(name).ValueKind == JsonValueKind.Null ? null : element.GetProperty(name).GetString();

    // ---- The shared vectors, which the TypeScript suite runs too ---------------------------------

    public static IEnumerable<object[]> BetweenCases() =>
        Enumerable.Range(0, Vectors.GetProperty("between").GetArrayLength()).Select(i => new object[] { i });

    [Theory]
    [MemberData(nameof(BetweenCases))]
    public void Matches_the_shared_between_vectors(int index)
    {
        var vector = Vectors.GetProperty("between")[index];
        Assert.Equal(vector.GetProperty("expected").GetString(), FractionalIndex.Between(Text(vector, "before"), Text(vector, "after")));
    }

    public static IEnumerable<object[]> InvalidCases() =>
        Enumerable.Range(0, Vectors.GetProperty("invalid").GetArrayLength()).Select(i => new object[] { i });

    [Theory]
    [MemberData(nameof(InvalidCases))]
    public void Rejects_the_shared_invalid_vectors(int index)
    {
        var vector = Vectors.GetProperty("invalid")[index];
        Assert.Throws<ArgumentException>(() => FractionalIndex.Between(Text(vector, "before"), Text(vector, "after")));
    }

    public static IEnumerable<object[]> BaseRowCases() =>
        Enumerable.Range(0, Vectors.GetProperty("baseRows").GetArrayLength()).Select(i => new object[] { i });

    [Theory]
    [MemberData(nameof(BaseRowCases))]
    public void Matches_the_shared_base_row_vectors(int index)
    {
        var vector = Vectors.GetProperty("baseRows")[index];
        Assert.Equal(vector.GetProperty("expected").GetString(), FractionalIndex.ForBaseRow(vector.GetProperty("index").GetInt32()));
    }

    // ---- Properties, over random inputs ----------------------------------------------------------

    /// <summary>Random valid keys: base-62 digits, never ending in "0".</summary>
    private static Gen<string> KeyGen =>
        from length in Gen.Choose(1, 8)
        from body in Gen.ArrayOf(Gen.Elements(FractionalIndex.Digits.ToCharArray()), length - 1)
        from last in Gen.Elements(FractionalIndex.Digits[1..].ToCharArray())
        select new string(body) + last;

    private static Arbitrary<string> Keys => Arb.From(KeyGen);

    [Fact]
    public void Between_two_random_keys_lands_strictly_between_them()
    {
        Prop.ForAll(Keys, Keys, (x, y) =>
        {
            if (x == y) return true; // Between needs two different keys; this case is not the property's business
            var (low, high) = string.CompareOrdinal(x, y) < 0 ? (x, y) : (y, x);

            var mid = FractionalIndex.Between(low, high);

            return string.CompareOrdinal(low, mid) < 0
                && string.CompareOrdinal(mid, high) < 0
                && mid[^1] != '0';
        }).QuickCheckThrowOnFailure();
    }

    [Fact]
    public void Between_a_key_and_nothing_sorts_after_it_and_before_it_sorts_before()
    {
        Prop.ForAll(Keys, key =>
        {
            var after = FractionalIndex.Between(key, null);
            var before = FractionalIndex.Between(null, key);
            return string.CompareOrdinal(after, key) > 0 && string.CompareOrdinal(before, key) < 0;
        }).QuickCheckThrowOnFailure();
    }

    /// <summary>
    /// Insert at random positions, many times. Whatever the positions, the keys must stay unique
    /// and in the order the list says: that is the whole job of the type.
    /// </summary>
    [Fact]
    public void Repeated_inserts_at_random_positions_keep_every_key_unique_and_in_order()
    {
        Prop.ForAll(Gen.ListOf(Gen.Choose(0, 1_000_000)).ToArbitrary(), positions =>
        {
            var keys = new List<string>();
            foreach (var p in positions.Take(300))
            {
                var at = keys.Count == 0 ? 0 : p % (keys.Count + 1); // insert before keys[at]
                var before = at == 0 ? null : keys[at - 1];
                var after = at == keys.Count ? null : keys[at];
                keys.Insert(at, FractionalIndex.Between(before, after));
            }

            return keys.Distinct().Count() == keys.Count
                && keys.Zip(keys.Skip(1), (a, b) => string.CompareOrdinal(a, b) < 0).All(ok => ok);
        }).QuickCheckThrowOnFailure();
    }

    [Fact]
    public void Base_row_keys_sort_in_index_order_and_leave_room_between_neighbours()
    {
        for (var i = 0; i < 99_999; i += 997)
        {
            var a = FractionalIndex.ForBaseRow(i);
            var b = FractionalIndex.ForBaseRow(i + 1);
            Assert.True(string.CompareOrdinal(a, b) < 0);

            var between = FractionalIndex.Between(a, b);
            Assert.True(string.CompareOrdinal(a, between) < 0 && string.CompareOrdinal(between, b) < 0);
        }
    }

    [Fact]
    public void Keys_grow_slowly_when_inserting_at_the_same_spot_forever()
    {
        // The worst case: always insert right after the same neighbour. Length should climb about
        // one character per several inserts, not one per insert. A regression here would make keys
        // (and the ops that carry them) balloon.
        var left = FractionalIndex.ForBaseRow(0);
        var right = FractionalIndex.ForBaseRow(1);
        var key = right;
        for (var i = 0; i < 500; i++) key = FractionalIndex.Between(left, key);

        Assert.True(key.Length < 120, $"key grew to {key.Length} characters after 500 inserts");
    }
}
