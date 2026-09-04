package executor

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"

	"github.com/ethpandaops/benchmarkoor/pkg/fsutil"
)

// PipelineArtifactName is the per test file holding the task timeline of one
// proof, written beside the step results of the test.
const PipelineArtifactName = "test.pipeline.json.gz"

// splitPipelines takes the pipeline out of every block log and writes it as
// the per test artifact. A browser reads the block logs file whole, so the
// timeline travels compressed and apart from it. A log that carries no
// pipeline passes through unchanged.
func splitPipelines(
	resultsDir string,
	blockLogs map[string]json.RawMessage,
	owner *fsutil.OwnerConfig,
) (map[string]json.RawMessage, error) {
	stripped := make(map[string]json.RawMessage, len(blockLogs))

	for testName, blockLog := range blockLogs {
		var fields map[string]json.RawMessage

		if err := json.Unmarshal(blockLog, &fields); err != nil || fields["pipeline"] == nil {
			stripped[testName] = blockLog

			continue
		}

		// The artifact is written once and read by a browser, so it takes the
		// slowest compression level into a buffer, where no step can fail.
		var buffer bytes.Buffer

		writer, err := gzip.NewWriterLevel(&buffer, gzip.BestCompression)
		if err != nil {
			panic(err)
		}

		if _, err := writer.Write(fields["pipeline"]); err != nil {
			panic(err)
		}

		if err := writer.Close(); err != nil {
			panic(err)
		}

		if err := WriteTestFile(resultsDir, testName, PipelineArtifactName, buffer.Bytes(), owner); err != nil {
			return nil, fmt.Errorf("writing pipeline of %s: %w", testName, err)
		}

		delete(fields, "pipeline")

		rest, err := json.Marshal(fields)
		if err != nil {
			return nil, fmt.Errorf("marshaling block log of %s: %w", testName, err)
		}

		stripped[testName] = rest
	}

	return stripped, nil
}
