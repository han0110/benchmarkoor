package blocklog

import (
	"encoding/json"
	"strings"

	"github.com/ethpandaops/benchmarkoor/pkg/client"
)

// provoorParser passes through the per-proof metric lines the provoor
// forwarder writes, one JSON object per line already carrying the block.hash
// the collector matches on, so parsing is a JSON validity check. Phase and
// progress lines are plain text and fall through.
type provoorParser struct{}

// NewProvoorParser creates a new provoor log parser.
func NewProvoorParser() Parser {
	return &provoorParser{}
}

// Ensure interface compliance.
var _ Parser = (*provoorParser)(nil)

// ParseLine returns JSON lines unchanged and skips everything else.
func (p *provoorParser) ParseLine(line string) (json.RawMessage, bool) {
	trimmed := strings.TrimSpace(line)
	if !strings.HasPrefix(trimmed, "{") || !json.Valid([]byte(trimmed)) {
		return nil, false
	}

	return json.RawMessage(trimmed), true
}

// ClientType returns the client type.
func (p *provoorParser) ClientType() client.ClientType {
	return client.ClientProvoor
}
