package backend

import (
	"github.com/toninfo/ton/internal/backend/core"
)

// AgentBackend is re-exported for callers that depend on the public backend package.
type AgentBackend = core.AgentBackend

// AgentRunRequest is re-exported for callers that depend on the public backend package.
type AgentRunRequest = core.AgentRunRequest
