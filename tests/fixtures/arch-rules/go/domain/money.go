package domain

import (
	"example.com/shop/shared"
)

type Money struct{}

func (x Money) Run() {
	shared.Text{}.Run()
}
