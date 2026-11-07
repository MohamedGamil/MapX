package infrastructure

import "github.com/jmoiron/sqlx"

type Database struct{}

func (d Database) Open() (*sqlx.DB, error) {
	return sqlx.Open("sqlite", "shop.db")
}
