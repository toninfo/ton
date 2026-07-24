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

// slashSpec describes one slash command for the `/` popup catalog.
type slashSpec struct {
	Name     string // e.g. "/driver"
	Usage    string // e.g. "/driver <name>"
	Desc     string
	NeedsArg bool // when true, completion inserts a trailing space
}

// slashCatalog is the OpenCode-style menu surface (aliases omitted; /review → /docs).
func slashCatalog() []slashSpec {
	return []slashSpec{
		{Name: "/start", Usage: "/start", Desc: "Plan and run the session", NeedsArg: false},
		{Name: "/docs", Usage: "/docs [preview|open|req|design]", Desc: "Review requirements and design", NeedsArg: false},
		{Name: "/status", Usage: "/status", Desc: "Show phase, queue, driver, and why", NeedsArg: false},
		{Name: "/todos", Usage: "/todos", Desc: "Toggle the plan sidebar", NeedsArg: false},
		{Name: "/stop", Usage: "/stop [soft|hard]", Desc: "Soft-stop or hard interrupt", NeedsArg: false},
		{Name: "/driver", Usage: "/driver <name>", Desc: "Switch coding agent (or auto)", NeedsArg: true},
		{Name: "/model", Usage: "/model <name>", Desc: "Switch clarify/plan model", NeedsArg: true},
		{Name: "/key", Usage: "/key <api_key>", Desc: "Save LLM API key", NeedsArg: true},
		{Name: "/queue", Usage: "/queue", Desc: "Show queued input during execute", NeedsArg: false},
		{Name: "/brief", Usage: "/brief <text>", Desc: "Queue a next-step brief", NeedsArg: true},
		{Name: "/skip", Usage: "/skip", Desc: "Queue skip for the current step", NeedsArg: false},
		{Name: "/export", Usage: "/export", Desc: "Re-export todos.md / report", NeedsArg: false},
	}
}

// filterSlashCatalog returns commands whose name starts with typed prefix (with or without leading /).
func filterSlashCatalog(typed string) []slashSpec {
	typed = strings.TrimSpace(typed)
	if typed == "" {
		return slashCatalog()
	}
	if !strings.HasPrefix(typed, "/") {
		typed = "/" + typed
	}
	low := strings.ToLower(typed)
	out := make([]slashSpec, 0, 8)
	for _, spec := range slashCatalog() {
		if strings.HasPrefix(strings.ToLower(spec.Name), low) {
			out = append(out, spec)
		}
	}
	return out
}

// enrichDriverSlashSpec injects detected driver options into /driver's description.
// current marks the session driver with '*' so the menu doubles as a switcher cheat-sheet.
func enrichDriverSlashSpec(items []slashSpec, choices []string, current string) []slashSpec {
	if len(items) == 0 || len(choices) == 0 {
		return items
	}
	desc := driverSlashDesc(choices, current)
	for i := range items {
		if items[i].Name != "/driver" {
			continue
		}
		items[i].Desc = desc
	}
	return items
}

// driverSlashDesc builds the menu blurb, e.g. "options: opencode*, claude, auto".
func driverSlashDesc(choices []string, current string) string {
	if len(choices) == 0 {
		return "Switch coding agent (or auto)"
	}
	cur := strings.ToLower(strings.TrimSpace(current))
	parts := make([]string, len(choices))
	for i, name := range choices {
		if cur != "" && name != "auto" && strings.EqualFold(name, cur) {
			parts[i] = name + "*"
		} else {
			parts[i] = name
		}
	}
	return "options: " + strings.Join(parts, ", ")
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
