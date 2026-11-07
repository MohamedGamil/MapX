package shared

import (
	"example.com/shop/domain"
)

type Result struct{}

func (x Result) Run() {
	domain.Money{}.Run()
}
