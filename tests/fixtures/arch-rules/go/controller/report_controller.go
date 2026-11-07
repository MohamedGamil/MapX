package controller

import (
	"example.com/shop/application"
	"example.com/shop/application/appinternal"
	"example.com/shop/infrastructure"
)

type ReportController struct{}

func (x ReportController) Run() {
	application.CancelOrder{}.Run()
	BaseController{}.Run()
	infrastructure.SqlOrderRepository{}.Run()
	appinternal.TaxRules{}.Run()
}
