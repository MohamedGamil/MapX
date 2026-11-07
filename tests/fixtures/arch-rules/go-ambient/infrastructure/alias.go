package infrastructure

import system "os"

type Home struct{}

func (h Home) Dir() string {
	value, _ := system.LookupEnv("HOME")
	return value
}
