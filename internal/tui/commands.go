package tui

import "strings"

type commandKind string

const (
	commandStart  commandKind = "start"
	commandTodos  commandKind = "todos"
	commandStatus commandKind = "status"
	commandStop   commandKind = "stop"
	commandDriver commandKind = "driver"
	commandModel  commandKind = "model"
	commandExport commandKind = "export"
	commandKey    commandKind = "key"
	commandBrief  commandKind = "brief"
	commandSkip   commandKind = "skip"
	commandQueue  commandKind = "queue"
	commandDocs   commandKind = "docs"
)

// command is the validated internal form of a user-entered slash command.
type command struct {
	kind     commandKind
	argument string
}

// parseCommand accepts only the small, documented slash command surface.
func parseCommand(input string) (command, bool) {
	fields := strings.Fields(input)
	if len(fields) == 0 {
		return command{}, false
	}

	switch fields[0] {
	case "/start":
		return noArgumentCommand(fields, commandStart)
	case "/todos":
		return noArgumentCommand(fields, commandTodos)
	case "/status":
		return noArgumentCommand(fields, commandStatus)
	case "/stop":
		return stopCommand(fields)
	case "/export":
		return noArgumentCommand(fields, commandExport)
	case "/driver":
		return oneArgumentCommand(fields, commandDriver)
	case "/model":
		return oneArgumentCommand(fields, commandModel)
	case "/key":
		return oneArgumentCommand(fields, commandKey)
	case "/brief":
		// The entire paragraph after /brief is used as a parameter (can contain spaces)
		if len(fields) < 2 {
			return command{}, false
		}
		return command{kind: commandBrief, argument: strings.TrimSpace(strings.TrimPrefix(input, fields[0]))}, true
	case "/skip":
		return noArgumentCommand(fields, commandSkip)
	case "/queue":
		return noArgumentCommand(fields, commandQueue)
	case "/docs", "/review":
		// /docs [open|preview|req|design] — Open the directory by default and do not fill the screen
		if len(fields) == 1 {
			return command{kind: commandDocs, argument: "open"}, true
		}
		if len(fields) == 2 {
			arg := strings.ToLower(fields[1])
			switch arg {
			case "preview", "open", "all", "req", "requirements", "design":
				return command{kind: commandDocs, argument: arg}, true
			}
		}
		return command{}, false
	default:
		return command{}, false
	}
}

func noArgumentCommand(fields []string, kind commandKind) (command, bool) {
	if len(fields) != 1 {
		return command{}, false
	}
	return command{kind: kind}, true
}

func oneArgumentCommand(fields []string, kind commandKind) (command, bool) {
	if len(fields) != 2 {
		return command{}, false
	}
	return command{kind: kind, argument: fields[1]}, true
}

// stopCommand accepts /stop, /stop soft, /stop hard.
func stopCommand(fields []string) (command, bool) {
	switch len(fields) {
	case 1:
		return command{kind: commandStop}, true
	case 2:
		mode := strings.ToLower(fields[1])
		if mode != "soft" && mode != "hard" {
			return command{}, false
		}
		return command{kind: commandStop, argument: mode}, true
	default:
		return command{}, false
	}
}
