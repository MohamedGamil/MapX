// Go: in no layer. main is an entry point nothing imports (orphan-element, a negative case).
package main

import "example.com/orphans/go/shapes"

func main() {
	_ = shapes.Area(2, 3)
}
