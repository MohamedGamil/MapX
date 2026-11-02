// Synthetic fixture (M5-10 review): XML doc code samples and attribute targets.
namespace Acme.Review
{
    /// <summary>Review.</summary>
    /// <code>
    /// <deprecated>not a tag</deprecated>
    /// </code>
    /// <example><code>@internal</code></example>
    // a plain comment between the doc and the declaration
    [Obsolete]
    public class Review
    {
        [return: NotNull]
        [method: Pure]
        public string M() { return ""; }
    }
}
