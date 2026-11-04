package infrastructure

import "os"

// None of these is ambient: os is a parameter or a local of another type, and a string or a comment
// only names it (os.Args, os.Getenv).
type local struct{}

func (local) Getenv(string) string { return "" }

type Shadow struct{}

func (s Shadow) Param(os local) string {
	return os.Getenv("HOME") + "os.Args"
}

func (s Shadow) Local() string {
	os := local{}
	return os.Getenv("HOME")
}

func (s Shadow) Pid() int {
	return os.Getpid()
}
