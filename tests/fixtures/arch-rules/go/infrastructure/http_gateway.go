// Synthetic (M5-19): references to packages outside the workspace, labelled in expected-externals.json.
package infrastructure

import (
	"fmt"
	"net/http"

	"example.com/shop/missing"
	"github.com/google/uuid"
	log "github.com/sirupsen/logrus"
)

type HttpGateway struct{}

func (x HttpGateway) Run() {
	fmt.Println("run")
	log.Info("run")
	_ = uuid.New()
	_ = http.Client{}
	missing.Gone()
}
