package infrastructure

import "os"

type Config struct{}

func (c Config) Port() string {
	return os.Getenv("PORT")
}

func (c Config) Args() []string {
	return os.Args[1:]
}
