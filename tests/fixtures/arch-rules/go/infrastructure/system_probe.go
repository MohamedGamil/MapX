// Synthetic (M5-23): Go modules attribution, labelled in expected-externals.json. golang.org/x/sys
// is required `// indirect` (through logrus), github.com/pkg/errors is in no go.mod or go.sum, and
// `C` is cgo's pseudo-package.
package infrastructure

import "C"

import (
	"os"

	"github.com/pkg/errors"
	"golang.org/x/sys/unix"
)

func SystemProbe() error {
	if unix.Getpid() != os.Getpid() {
		return errors.New("pid")
	}
	return nil
}
