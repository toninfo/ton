//go:build !windows

package tui

import "os"

// syncConsoleCursor: There is no Win32 console cursor in Unix; the AltScreen path does not use imeFixWriter.
func syncConsoleCursor(_ *os.File, _, _ int) {}
