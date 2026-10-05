package executor

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/ethpandaops/benchmarkoor/pkg/eest"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestStatelessFixtureSpans pins that each fixture of a multi-fixture file
// has a span that holds exactly its value, and that a provider reading only
// its span yields the line a conversion of the whole file produces.
func TestStatelessFixtureSpans(t *testing.T) {
	var file bytes.Buffer

	file.WriteString("{")

	for index, name := range []string{"empty_block.json", "parallel_execution_serial_chain.json"} {
		data, err := os.ReadFile(filepath.Join("..", "eest", "testdata", name))
		require.NoError(t, err)

		entries := bytes.TrimSpace(data)
		if index > 0 {
			file.WriteString(",")
		}

		file.Write(entries[1 : len(entries)-1])
	}

	file.WriteString("}\n")

	path := filepath.Join(t.TempDir(), "fixtures.json")
	require.NoError(t, os.WriteFile(path, file.Bytes(), 0644))

	fixtures, err := eest.ParseFixtureFile(file.Bytes())
	require.NoError(t, err)
	require.Len(t, fixtures, 2)

	spans, err := indexFixtureSpans(path)
	require.NoError(t, err)
	require.Len(t, spans, len(fixtures))

	for name, fixture := range fixtures {
		span := spans[name]
		assert.Equal(t, byte('{'), file.Bytes()[span.offset])
		assert.Equal(t, byte('}'), file.Bytes()[span.offset+span.length-1])

		want, err := eest.ConvertStatelessFixture(name, fixture)
		require.NoError(t, err)

		provider := &statelessFixtureProvider{path: path, name: name}
		assert.Equal(t, want.TestLines, provider.Lines())
	}
}
