package infrastructure

import (
	"fmt"

	"github.com/sirupsen/logrus"
)

type Server struct{}

func (s Server) Start() {
	fmt.Println("server")
	logrus.Info("server")
}
