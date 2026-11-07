// Synthetic (M5-24-R1): ambient access, labelled in expected-externals.json.
package domain

import "os"

type Order struct{}

func (o Order) Currency() string {
	return os.Getenv("CURRENCY")
}
