package cli

import "fmt"

// exitError carries a process exit code through cobra without treating it as a failure.
type exitError struct {
	code int
}

func (e *exitError) Error() string {
	return fmt.Sprintf("exit code %d", e.code)
}
