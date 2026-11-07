package domain

import (
	"example.com/shop/domain/ids"
	"example.com/shop/infrastructure"
)

type Order struct{}

func (x Order) Run() {
	infrastructure.SqlOrderRepository{}.Run()
	Money{}.Run()
	ids.OrderId{}.Run()
	LedgerHelper{}.Run()
}
