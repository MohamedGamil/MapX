package controller

import (
	"example.com/shop/application"
	"example.com/shop/application/appinternal"
	"example.com/shop/domain"
)

type OrderController struct{}

func (x OrderController) Run() {
	application.PlaceOrder{}.Run()
	BaseController{}.Run()
	domain.Order{}.Run()
	appinternal.PricingRules{}.Run()
}
