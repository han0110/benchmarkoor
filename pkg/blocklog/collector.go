package blocklog

import (
	"encoding/json"
	"io"
	"slices"
	"sync"
)

// Collector intercepts log streams, parses JSON payloads from client logs,
// and associates them with tests using blockHash matching.
type Collector interface {
	// RegisterBlockHash registers a blockHash for a test name.
	// When a log line with this blockHash is seen, it will be associated with the test.
	// If the log already arrived (buffered in unmatched), it's immediately associated.
	// Tests that share a blockHash are served in registration order.
	RegisterBlockHash(testName, blockHash string)

	// ReleaseBlockHash drops a pending registration, so a test that shares the
	// blockHash is no longer held behind it. It does nothing when the test does
	// not wait on the blockHash.
	ReleaseBlockHash(testName, blockHash string)

	// GetBlockLogs returns all captured block logs mapped by test name.
	GetBlockLogs() map[string]json.RawMessage

	// Writer returns an io.Writer that intercepts log lines, parses them,
	// and passes them through to the downstream writer.
	Writer() io.Writer
}

// NewCollector creates a new block log collector with the given parser
// and downstream writer.
func NewCollector(parser Parser, downstream io.Writer) Collector {
	return &collector{
		parser:        parser,
		downstream:    downstream,
		pendingHashes: make(map[string][]string, 64),
		blockLogs:     make(map[string]json.RawMessage, 64),
		unmatched:     make(map[string][]json.RawMessage, 64),
	}
}

type collector struct {
	parser     Parser
	downstream io.Writer

	mu            sync.RWMutex
	pendingHashes map[string][]string          // blockHash -> test names in registration order (awaiting logs)
	blockLogs     map[string]json.RawMessage   // testName -> payload (matched)
	unmatched     map[string][]json.RawMessage // blockHash -> payloads in arrival order (logs before registration)

	// Line buffering for the writer.
	bufMu   sync.Mutex
	lineBuf []byte
}

// Ensure interface compliance.
var _ Collector = (*collector)(nil)

// RegisterBlockHash registers a blockHash for a test name.
// If a log with this hash was already seen, the oldest one is immediately matched.
func (c *collector) RegisterBlockHash(testName, blockHash string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	// Take the oldest buffered log for this hash (late registration).
	if payloads := c.unmatched[blockHash]; len(payloads) > 0 {
		c.blockLogs[testName] = payloads[0]

		if len(payloads) == 1 {
			delete(c.unmatched, blockHash)
		} else {
			c.unmatched[blockHash] = payloads[1:]
		}

		return
	}

	// Otherwise, queue behind the tests that already wait for this hash.
	c.pendingHashes[blockHash] = append(c.pendingHashes[blockHash], testName)
}

// ReleaseBlockHash drops a pending registration, keeping the order of the
// tests that stay.
func (c *collector) ReleaseBlockHash(testName, blockHash string) {
	c.mu.Lock()
	defer c.mu.Unlock()

	pending := c.pendingHashes[blockHash]

	index := slices.Index(pending, testName)
	if index < 0 {
		return
	}

	if len(pending) == 1 {
		delete(c.pendingHashes, blockHash)

		return
	}

	c.pendingHashes[blockHash] = slices.Delete(pending, index, index+1)
}

// GetBlockLogs returns all captured block logs.
func (c *collector) GetBlockLogs() map[string]json.RawMessage {
	c.mu.RLock()
	defer c.mu.RUnlock()

	// Return a copy to avoid concurrent modification.
	result := make(map[string]json.RawMessage, len(c.blockLogs))
	for k, v := range c.blockLogs {
		result[k] = v
	}

	return result
}

// Writer returns an io.Writer that intercepts and parses log lines.
func (c *collector) Writer() io.Writer {
	return &collectorWriter{collector: c}
}

// extractBlockHashFromPayload extracts the block hash from a parsed log payload.
// All clients use the same structure: { "block": { "hash": "0x..." } }.
func extractBlockHashFromPayload(payload json.RawMessage) (string, bool) {
	var bp struct {
		Block struct {
			Hash string `json:"hash"`
		} `json:"block"`
	}

	if err := json.Unmarshal(payload, &bp); err != nil || bp.Block.Hash == "" {
		return "", false
	}

	return bp.Block.Hash, true
}

// collectorWriter implements io.Writer and wraps the collector.
type collectorWriter struct {
	collector *collector
}

// Ensure interface compliance.
var _ io.Writer = (*collectorWriter)(nil)

// Write implements io.Writer.
func (w *collectorWriter) Write(p []byte) (n int, err error) {
	n = len(p)

	// First, write to downstream (always pass through).
	if w.collector.downstream != nil {
		if _, err := w.collector.downstream.Write(p); err != nil {
			return n, err
		}
	}

	// Buffer and process lines.
	w.collector.bufMu.Lock()
	w.collector.lineBuf = append(w.collector.lineBuf, p...)

	// Process complete lines.
	for {
		idx := -1
		for i, b := range w.collector.lineBuf {
			if b == '\n' {
				idx = i
				break
			}
		}

		if idx == -1 {
			break
		}

		// Extract the line (without newline).
		line := string(w.collector.lineBuf[:idx])
		w.collector.lineBuf = w.collector.lineBuf[idx+1:]

		// Try to parse JSON from this line.
		if payload, ok := w.collector.parser.ParseLine(line); ok {
			// Extract blockHash from the payload.
			if blockHash, hashOK := extractBlockHashFromPayload(payload); hashOK {
				w.collector.mu.Lock()
				// Give the payload to the oldest test waiting for this hash.
				if pending := w.collector.pendingHashes[blockHash]; len(pending) > 0 {
					w.collector.blockLogs[pending[0]] = payload

					if len(pending) == 1 {
						delete(w.collector.pendingHashes, blockHash)
					} else {
						w.collector.pendingHashes[blockHash] = pending[1:]
					}
				} else {
					// No registration yet: buffer for late registration.
					w.collector.unmatched[blockHash] = append(w.collector.unmatched[blockHash], payload)
				}
				w.collector.mu.Unlock()
			}
		}
	}

	w.collector.bufMu.Unlock()

	return n, nil
}
