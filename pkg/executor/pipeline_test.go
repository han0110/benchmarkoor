package executor

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"os"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestSplitPipelinesMovesThePipelineIntoItsOwnArtifact(t *testing.T) {
	dir := t.TempDir()
	withPipeline := "benchmark/test_x.py::test_a"
	withoutPipeline := "benchmark/test_x.py::test_b"
	pipeline := `{"schemaVersion":1,"workers":[{"name":"worker_0","node":"node1"}],"tasks":[[2,0,"24",1015,1100,[[0,30]]]]}`

	stripped, err := splitPipelines(dir, map[string]json.RawMessage{
		withPipeline:    json.RawMessage(`{"block":{"hash":"0xa"},"proofSeconds":4.6,"pipeline":` + pipeline + `}`),
		withoutPipeline: json.RawMessage(`{"block":{"hash":"0xb"},"proofSeconds":2.1}`),
	}, nil)
	require.NoError(t, err)

	require.JSONEq(t, `{"block":{"hash":"0xa"},"proofSeconds":4.6}`, string(stripped[withPipeline]))
	require.JSONEq(t, `{"block":{"hash":"0xb"},"proofSeconds":2.1}`, string(stripped[withoutPipeline]))

	artifact, err := os.ReadFile(dir + "/" + sanitizeResultPath(withPipeline) + "/" + PipelineArtifactName)
	require.NoError(t, err)

	reader, err := gzip.NewReader(bytes.NewReader(artifact))
	require.NoError(t, err)

	decoded, err := io.ReadAll(reader)
	require.NoError(t, err)
	require.Equal(t, pipeline, string(decoded))

	_, err = os.Stat(dir + "/" + sanitizeResultPath(withoutPipeline) + "/" + PipelineArtifactName)
	require.ErrorIs(t, err, os.ErrNotExist)
}
