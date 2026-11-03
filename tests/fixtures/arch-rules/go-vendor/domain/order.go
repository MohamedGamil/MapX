package domain

import "github.com/jmoiron/sqlx"

type Order struct{}

func (o Order) Save() error {
	_, err := sqlx.Connect("sqlite", "shop.db")
	return err
}
