package vault

// Vault keeps the ledger's secrets. Under domain/internal/, Go lets only code rooted at domain/
// import it: with native markers, Application's import is an internal-element violation.
type Vault struct{}

func (v Vault) Seal() {
}
