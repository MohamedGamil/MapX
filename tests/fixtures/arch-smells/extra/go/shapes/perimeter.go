// Go: in no layer, and nothing calls Perimeter, but main imports the package it shares with area.go
// (orphan-element, a negative case: an import names the package, not one of its files).
package shapes

func Perimeter(w, h int) int {
	return 2 * (w + h)
}
