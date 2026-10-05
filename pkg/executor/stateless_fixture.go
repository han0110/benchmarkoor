package executor

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"

	"github.com/ethpandaops/benchmarkoor/pkg/eest"
)

// statelessFixtureProvider implements StepProvider for one stateless fixture
// and converts it each time the step is read. The line it yields is identical
// to the one discovery produced, so the suite hash is unchanged.
type statelessFixtureProvider struct {
	path string
	name string
}

// fixtureSpan is the byte range of one fixture value inside its file.
type fixtureSpan struct {
	offset int64
	length int64
}

// statelessFixtureSpans maps a fixture file path to the spans of its
// fixtures. A read then decodes only its own fixture instead of the whole
// file, which holds up to hundreds of fixtures.
var statelessFixtureSpans sync.Map

// Lines converts the fixture into its engine_proveStatelessValidator line.
// Discovery converted the same fixture once already, so a failure means the
// fixture file changed under the run.
func (p *statelessFixtureProvider) Lines() []string {
	spans, ok := statelessFixtureSpans.Load(p.path)
	if !ok {
		indexed, err := indexFixtureSpans(p.path)
		if err != nil {
			panic(fmt.Sprintf("indexing stateless fixtures %s: %v", p.path, err))
		}

		spans, _ = statelessFixtureSpans.LoadOrStore(p.path, indexed)
	}

	span, ok := spans.(map[string]fixtureSpan)[p.name]
	if !ok {
		panic(fmt.Sprintf("stateless fixture %s not found in %s", p.name, p.path))
	}

	file, err := os.Open(p.path)
	if err != nil {
		panic(fmt.Sprintf("reading stateless fixture %s: %v", p.path, err))
	}
	defer func() { _ = file.Close() }()

	data := make([]byte, span.length)
	if _, err := file.ReadAt(data, span.offset); err != nil {
		panic(fmt.Sprintf("reading stateless fixture %s in %s: %v", p.name, p.path, err))
	}

	var fixture eest.Fixture
	if err := json.Unmarshal(data, &fixture); err != nil {
		panic(fmt.Sprintf("parsing stateless fixture %s in %s: %v", p.name, p.path, err))
	}

	converted, err := eest.ConvertStatelessFixture(p.name, &fixture)
	if err != nil {
		panic(fmt.Sprintf("converting stateless fixture %s in %s: %v", p.name, p.path, err))
	}

	return converted.TestLines
}

// Content returns the full content as bytes for hashing.
func (p *statelessFixtureProvider) Content() []byte {
	return []byte(strings.Join(p.Lines(), "\n"))
}

// indexFixtureSpans streams a fixture file, which is one JSON object keyed by
// fixture name, and returns the byte range of each fixture value. It holds one
// fixture in memory at a time.
func indexFixtureSpans(path string) (map[string]fixtureSpan, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = file.Close() }()

	decoder := json.NewDecoder(file)

	if token, err := decoder.Token(); err != nil || token != json.Delim('{') {
		return nil, fmt.Errorf("expected a JSON object: %v", err)
	}

	spans := make(map[string]fixtureSpan)

	var value json.RawMessage

	for decoder.More() {
		token, err := decoder.Token()
		if err != nil {
			return nil, err
		}

		if err := decoder.Decode(&value); err != nil {
			return nil, err
		}

		// The decoder stops right after the value, and the raw message holds
		// the value without surrounding whitespace.
		end := decoder.InputOffset()
		spans[token.(string)] = fixtureSpan{offset: end - int64(len(value)), length: int64(len(value))}
	}

	if token, err := decoder.Token(); err != nil || token != json.Delim('}') {
		return nil, fmt.Errorf("expected the end of the JSON object: %v", err)
	}

	return spans, nil
}
