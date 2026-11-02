package infrastructure

import (
	"example.com/shop/domain"
	"example.com/shop/support"
)

type MailGateway struct{}

func (x MailGateway) Run() {
	domain.Order{}.Run()
	support.Uuid{}.Run()
}
