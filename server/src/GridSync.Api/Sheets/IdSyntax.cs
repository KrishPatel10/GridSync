using System.Text.RegularExpressions;

namespace GridSync.Api.Sheets;

/// <summary>
/// What a sheet name or a node id may look like: 1 to 64 letters, digits, hyphens or underscores.
/// One definition, used by the hub when joining and by the history endpoints, so a name one accepts
/// is a name the other accepts.
/// </summary>
public static partial class IdSyntax
{
    [GeneratedRegex("^[A-Za-z0-9_-]{1,64}$")]
    private static partial Regex Pattern();

    public static bool IsValid(string? id) => !string.IsNullOrEmpty(id) && Pattern().IsMatch(id);
}
