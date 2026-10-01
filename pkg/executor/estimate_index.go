package executor

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"time"

	"github.com/ethpandaops/benchmarkoor/pkg/fsutil"
)

// EstimateIndex contains the aggregated index of all cost estimates.
type EstimateIndex struct {
	Generated int64                 `json:"generated"`
	Entries   []*EstimateIndexEntry `json:"entries"`
}

// EstimateIndexEntry contains summary information for a single cost estimate.
type EstimateIndexEntry struct {
	EstimateID string                 `json:"estimate_id"`
	Timestamp  int64                  `json:"timestamp"`
	SuiteHash  string                 `json:"suite_hash"`
	Instance   EstimateIndexInstance  `json:"instance"`
	Metadata   map[string]string      `json:"metadata,omitempty"`
	Image      string                 `json:"image"`
	Tests      EstimateIndexTestStats `json:"tests"`
	Cost       map[string]uint64      `json:"cost"`
}

// EstimateIndexInstance contains the client instance information for the
// estimate index.
type EstimateIndexInstance struct {
	ID     string `json:"id"`
	Client string `json:"client"`
}

// EstimateIndexTestStats contains the test counts for the estimate index.
type EstimateIndexTestStats struct {
	TestsPassed int `json:"tests_passed"`
	TestsFailed int `json:"tests_failed"`
}

// estimateArtifactJSON holds the result.estimate.json fields that the index
// reads.
type estimateArtifactJSON struct {
	Timestamp int64                 `json:"timestamp"`
	SuiteHash string                `json:"suite_hash"`
	Instance  EstimateIndexInstance `json:"instance"`
	Metadata  struct {
		Labels map[string]string `json:"labels"`
	} `json:"metadata"`
	Image string `json:"image"`
	Tests map[string]struct {
		Cost map[string]uint64 `json:"cost"`
	} `json:"tests"`
	Failures map[string]string `json:"failures"`
}

// GenerateEstimateIndex scans the results directory and builds an index from
// all estimates.
func GenerateEstimateIndex(resultsDir string) (*EstimateIndex, error) {
	estimatesDir := filepath.Join(resultsDir, "estimates")

	entries, err := os.ReadDir(estimatesDir)
	if err != nil {
		if os.IsNotExist(err) {
			return &EstimateIndex{
				Generated: time.Now().Unix(),
				Entries:   make([]*EstimateIndexEntry, 0),
			}, nil
		}

		return nil, fmt.Errorf("reading estimates directory: %w", err)
	}

	indexEntries := make([]*EstimateIndexEntry, 0, len(entries))

	for _, entry := range entries {
		indexEntry, err := buildEstimateIndexEntry(estimatesDir, entry.Name())
		if err != nil {
			// Skip files and directories without a parseable artifact. The read
			// follows symlinks, so the index keeps a symlinked estimate directory.
			continue
		}

		indexEntries = append(indexEntries, indexEntry)
	}

	// Sort entries by timestamp, newest first. Equal timestamps keep the name
	// order of os.ReadDir.
	sort.SliceStable(indexEntries, func(i, j int) bool {
		return indexEntries[i].Timestamp > indexEntries[j].Timestamp
	})

	return &EstimateIndex{
		Generated: time.Now().Unix(),
		Entries:   indexEntries,
	}, nil
}

// buildEstimateIndexEntry creates an index entry from a single estimate
// directory.
func buildEstimateIndexEntry(estimatesDir, estimateID string) (*EstimateIndexEntry, error) {
	artifactData, err := os.ReadFile(filepath.Join(estimatesDir, estimateID, "result.estimate.json"))
	if err != nil {
		return nil, fmt.Errorf("reading result.estimate.json: %w", err)
	}

	var artifact estimateArtifactJSON
	if err := json.Unmarshal(artifactData, &artifact); err != nil {
		return nil, fmt.Errorf("parsing result.estimate.json: %w", err)
	}

	cost := make(map[string]uint64)

	for _, test := range artifact.Tests {
		for kind, value := range test.Cost {
			cost[kind] += value
		}
	}

	return &EstimateIndexEntry{
		EstimateID: estimateID,
		Timestamp:  artifact.Timestamp,
		SuiteHash:  artifact.SuiteHash,
		Instance:   artifact.Instance,
		Metadata:   artifact.Metadata.Labels,
		Image:      artifact.Image,
		Tests: EstimateIndexTestStats{
			TestsPassed: len(artifact.Tests),
			TestsFailed: len(artifact.Failures),
		},
		Cost: cost,
	}, nil
}

// WriteEstimateIndex writes the index to index.json in the estimates
// subdirectory.
func WriteEstimateIndex(resultsDir string, index *EstimateIndex, owner *fsutil.OwnerConfig) error {
	estimatesDir := filepath.Join(resultsDir, "estimates")

	if err := fsutil.MkdirAll(estimatesDir, 0755, owner); err != nil {
		return fmt.Errorf("creating estimates directory: %w", err)
	}

	indexPath := filepath.Join(estimatesDir, "index.json")

	data, err := json.MarshalIndent(index, "", "  ")
	if err != nil {
		return fmt.Errorf("marshaling index: %w", err)
	}

	if err := fsutil.WriteFile(indexPath, data, 0644, owner); err != nil {
		return fmt.Errorf("writing index.json: %w", err)
	}

	return nil
}
