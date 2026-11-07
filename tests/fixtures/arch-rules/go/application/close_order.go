package application

import (
	"example.com/shop/domain"
	"example.com/shop/domain/internal/vault"
	"example.com/shop/internal/ledger"
)

type CloseOrder struct{}

func (x CloseOrder) Run() {
	domain.Money{}.Run()
	ledger.Journal{}.Record()
	vault.Vault{}.Seal()
}
