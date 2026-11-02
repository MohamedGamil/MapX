// Synthetic fixture (M5-10): C# attributes and XML doc tags on symbols.
namespace Acme.Shop
{
    /// <summary>An order.</summary>
    /// <remarks>
    /// Kept for
    /// compatibility.
    /// </remarks>
    [Serializable]
    [Table("orders",
        Schema = "shop"), Obsolete("use OrderV2")]
    public class Order
    {
        /// <summary>Runs it.</summary>
        /// <param name="id">the id</param>
        /// <exception cref="System.InvalidOperationException">when closed</exception>
        [HttpGet("{id}")]
        [System.ObsoleteAttribute]
        public string Run(int id) { return ""; }

        public void Plain() { }
    }
}
