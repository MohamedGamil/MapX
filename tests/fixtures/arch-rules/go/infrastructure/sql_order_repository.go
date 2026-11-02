package infrastructure

import (
	"example.com/shop/domain"
)

type SqlOrderRepository struct{}

func (x SqlOrderRepository) Run() {
	domain.Order{}.Run()
}
