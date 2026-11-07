package application

import (
	"example.com/shop/application/appinternal"
	"example.com/shop/domain"
	"example.com/shop/support"
)

type PlaceOrder struct{}

func (x PlaceOrder) Run() {
	domain.Order{}.Run()
	appinternal.PricingRules{}.Run()
	domain.LedgerHelper{}.Run()
	support.Clock{}.Run()
}
