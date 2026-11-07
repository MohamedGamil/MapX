package ledger

// Journal records ledger entries. Go lets the whole module import a module-root internal/
// package, so with native markers Application's use of it stays allowed; the architecture puts it
// in the Domain layer.
type Journal struct{}

func (j Journal) Record() {
}
