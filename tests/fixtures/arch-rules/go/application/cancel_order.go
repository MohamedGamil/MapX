package application

import (
	"example.com/shop/domain"
	"example.com/shop/shared"
)

type CancelOrder struct{}

func (x CancelOrder) Run() {
	shared.Result{}.Run()
	domain.AuditTrail{}.Run()
}
