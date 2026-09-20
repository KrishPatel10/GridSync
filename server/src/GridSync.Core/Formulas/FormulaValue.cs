namespace GridSync.Core.Formulas;

public enum ValueKind
{
    /// <summary>A cell with nothing in it. Behaves as 0, "" or FALSE depending on context.</summary>
    Empty,
    Number,
    Text,
    Boolean,
    Error,
}

public enum FormulaError
{
    DivideByZero,
    Value,
    Ref,
    Name,
    /// <summary>
    /// A result that is not a finite number (overflow, or 0^0, or a negative number to a
    /// fractional power). Excel has the same error. Without it, Infinity and NaN would leak out
    /// and print differently in C# and JavaScript.
    /// </summary>
    Num,
    Cycle,
    /// <summary>The formula text does not parse. Produced around the evaluator, never by it.</summary>
    Syntax,
}

/// <summary>
/// What a cell is worth: the result of a formula, or a constant read from raw text. Errors are
/// values, not exceptions, so "=1/0+5" is simply #DIV/0! carried up the tree.
/// </summary>
public readonly struct FormulaValue : IEquatable<FormulaValue>
{
    private readonly double _number;
    private readonly string? _text;
    private readonly FormulaError _error;

    private FormulaValue(ValueKind kind, double number, string? text, FormulaError error)
    {
        Kind = kind;
        _number = number;
        _text = text;
        _error = error;
    }

    public ValueKind Kind { get; }

    public bool IsError => Kind == ValueKind.Error;

    /// <summary>Numbers, and booleans as 1 or 0.</summary>
    public double Number => _number;

    public string Text => _text ?? string.Empty;

    public bool Boolean => _number != 0;

    public FormulaError Error => _error;

    public static readonly FormulaValue Empty = default;

    /// <summary>
    /// Callers must pass a finite number (the evaluator checks). Negative zero is turned into
    /// plain zero here, once, because "-0" would print differently in C# and JavaScript.
    /// </summary>
    public static FormulaValue FromNumber(double value) =>
        new(ValueKind.Number, value == 0 ? 0 : value, null, default);

    public static FormulaValue FromText(string value) => new(ValueKind.Text, 0, value, default);

    public static FormulaValue FromBoolean(bool value) => new(ValueKind.Boolean, value ? 1 : 0, null, default);

    public static FormulaValue FromError(FormulaError error) => new(ValueKind.Error, 0, null, error);

    /// <summary>
    /// How the sheet reads a constant cell: nothing is Empty, text that is entirely a number is a
    /// number ("5" makes =A1+1 equal 6), everything else is text. Formulas (raw text starting
    /// with "=") are not handled here; the caller evaluates those.
    /// </summary>
    public static FormulaValue FromRaw(string? raw)
    {
        if (string.IsNullOrEmpty(raw)) return Empty;
        return NumberText.TryParse(raw, out var number) ? FromNumber(number) : FromText(raw);
    }

    /// <summary>The text a cell shows for this value: "3", "hello", "TRUE", "#DIV/0!".</summary>
    public string ToDisplayString() => Kind switch
    {
        ValueKind.Empty => string.Empty,
        ValueKind.Number => NumberText.ToText(_number),
        ValueKind.Text => Text,
        ValueKind.Boolean => Boolean ? "TRUE" : "FALSE",
        _ => ErrorCode(_error),
    };

    public static string ErrorCode(FormulaError error) => error switch
    {
        FormulaError.DivideByZero => "#DIV/0!",
        FormulaError.Value => "#VALUE!",
        FormulaError.Ref => "#REF!",
        FormulaError.Name => "#NAME?",
        FormulaError.Num => "#NUM!",
        FormulaError.Cycle => "#CYCLE!",
        FormulaError.Syntax => "#ERROR!",
        _ => throw new ArgumentOutOfRangeException(nameof(error)),
    };

    public bool Equals(FormulaValue other) =>
        Kind == other.Kind && _number == other._number && _text == other._text && _error == other._error;

    public override bool Equals(object? obj) => obj is FormulaValue other && Equals(other);

    public override int GetHashCode() => HashCode.Combine(Kind, _number, _text, _error);

    public static bool operator ==(FormulaValue a, FormulaValue b) => a.Equals(b);

    public static bool operator !=(FormulaValue a, FormulaValue b) => !a.Equals(b);

    public override string ToString() => Kind switch
    {
        ValueKind.Empty => "Empty",
        ValueKind.Text => $"Text(\"{_text}\")",
        ValueKind.Error => $"Error({ErrorCode(_error)})",
        _ => $"{Kind}({ToDisplayString()})",
    };
}
