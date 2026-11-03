// Synthetic (M5-23): modules only test code uses are dev-only (expected-externals.json).
// github.com/google/uuid is also used by HttpGateway, so it stays production.
package infrastructure

import (
	"testing"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"gopkg.in/yaml.v3"
)

func TestHttpGateway(t *testing.T) {
	assert.NotEqual(t, uuid.Nil, uuid.New())
	_ = yaml.Node{}
}
