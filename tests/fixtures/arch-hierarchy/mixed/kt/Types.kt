// Synthetic fixture (M5-09 review): an interface extending an interface (stored as implements).
package kt

interface KI
interface KJ : KI
open class KBase : KJ
