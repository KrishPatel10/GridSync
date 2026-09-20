using GridSync.Core.Formulas;

namespace GridSync.Core.Tests.Formulas;

public class TokenizerTests
{
    /// <summary>Token kinds joined by spaces, without the trailing End.</summary>
    private static string Kinds(string source, int start = 0) =>
        string.Join(' ', Tokenizer.Tokenize(source, start).SkipLast(1).Select(t => t.Kind));

    private static Token Single(string source)
    {
        var tokens = Tokenizer.Tokenize(source);
        Assert.Equal(2, tokens.Count); // the token plus End
        return tokens[0];
    }

    [Fact]
    public void Splits_a_realistic_formula()
    {
        Assert.Equal(
            "Function LeftParen CellRef Colon CellRef RightParen Star Number Plus CellRef",
            Kinds("SUM(A1:A3)*2+B1"));
    }

    [Fact]
    public void Always_ends_with_an_End_token_at_the_end_of_the_text()
    {
        var tokens = Tokenizer.Tokenize("1 + 2");
        Assert.Equal(TokenKind.End, tokens[^1].Kind);
        Assert.Equal(5, tokens[^1].Position);
    }

    [Fact]
    public void Can_start_after_the_leading_equals_sign()
    {
        var tokens = Tokenizer.Tokenize("=A1", start: 1);
        Assert.Equal(TokenKind.CellRef, tokens[0].Kind);
        Assert.Equal(1, tokens[0].Position); // positions still point into the original text
    }

    [Theory]
    [InlineData("12", 12.0)]
    [InlineData("3.14", 3.14)]
    [InlineData(".5", 0.5)]
    [InlineData("1.", 1.0)]
    [InlineData("1e3", 1000.0)]
    [InlineData("2.5E-2", 0.025)]
    [InlineData("1E+2", 100.0)]
    public void Reads_numbers(string text, double expected)
    {
        var token = Single(text);
        Assert.Equal(TokenKind.Number, token.Kind);
        Assert.Equal(expected, token.Number);
    }

    [Fact]
    public void An_e_without_digits_is_not_an_exponent()
    {
        // "2e" is the number 2 followed by the name "e"; the parser will reject the pair.
        Assert.Equal("Number Name", Kinds("2e"));
    }

    [Fact]
    public void Numbers_do_not_include_a_leading_minus() =>
        Assert.Equal("Minus Number", Kinds("-5"));

    [Fact]
    public void Rejects_numbers_too_big_for_a_double()
    {
        var ex = Assert.Throws<FormulaSyntaxException>(() => Tokenizer.Tokenize("1e999"));
        Assert.Equal(0, ex.Position);
    }

    [Theory]
    [InlineData("\"hello\"", "hello")]
    [InlineData("\"\"", "")]
    [InlineData("\"say \"\"hi\"\"\"", "say \"hi\"")]
    [InlineData("\"a + b\"", "a + b")]
    public void Reads_strings_and_unescapes_doubled_quotes(string source, string expected)
    {
        var token = Single(source);
        Assert.Equal(TokenKind.String, token.Kind);
        Assert.Equal(expected, token.Text);
    }

    [Fact]
    public void Reports_where_an_unterminated_string_started()
    {
        var ex = Assert.Throws<FormulaSyntaxException>(() => Tokenizer.Tokenize("1&\"oops"));
        Assert.Equal(2, ex.Position);
    }

    [Theory]
    [InlineData("A1", TokenKind.CellRef)]
    [InlineData("aa10", TokenKind.CellRef)]
    [InlineData("XFD1", TokenKind.CellRef)]
    [InlineData("A0", TokenKind.Name)]      // rows start at 1
    [InlineData("ABCD1", TokenKind.Name)]   // columns are at most 3 letters
    [InlineData("TAX", TokenKind.Name)]
    [InlineData("_x", TokenKind.Name)]
    [InlineData("SUM(", TokenKind.Function)]
    [InlineData("sum(", TokenKind.Function)]
    [InlineData("LOG10(", TokenKind.Function)] // looks like a cell, but the "(" wins
    public void Classifies_words(string source, TokenKind expected) =>
        Assert.Equal(expected, Tokenizer.Tokenize(source)[0].Kind);

    [Fact]
    public void A_space_before_the_paren_means_it_is_not_a_function_call() =>
        Assert.Equal("Name LeftParen", Kinds("SUM ("));

    [Fact]
    public void Keeps_the_original_case_of_words() =>
        Assert.Equal("aa10", Single("aa10").Text);

    [Fact]
    public void Reads_every_operator_including_two_character_ones()
    {
        Assert.Equal(
            "Plus Minus Star Slash Caret Ampersand Equal NotEqual Less LessOrEqual Greater GreaterOrEqual " +
            "LeftParen RightParen Comma Colon",
            Kinds("+ - * / ^ & = <> < <= > >= ( ) , :"));
    }

    [Fact]
    public void Two_character_operators_need_no_spaces() =>
        Assert.Equal("CellRef LessOrEqual CellRef NotEqual CellRef", Kinds("A1<=B1<>C1"));

    [Fact]
    public void Skips_spaces_tabs_and_newlines() =>
        Assert.Equal("Number Plus Number", Kinds(" 1\t+\r\n 2 "));

    [Theory]
    [InlineData("1 + $A$1", 4)]  // absolute references are not supported yet
    [InlineData("1 ! 2", 2)]
    [InlineData("1 + 2", 1)] // non-breaking space: only plain whitespace is skipped
    public void Rejects_unexpected_characters_with_their_position(string source, int position)
    {
        var ex = Assert.Throws<FormulaSyntaxException>(() => Tokenizer.Tokenize(source));
        Assert.Equal(position, ex.Position);
    }
}
