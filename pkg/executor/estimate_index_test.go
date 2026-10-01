package executor

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestGenerateEstimateIndex(t *testing.T) {
	t.Run("summarises estimates newest first", func(t *testing.T) {
		resultsDir := t.TempDir()
		estimatesDir := filepath.Join(resultsDir, "estimates")

		for estimateID, artifact := range map[string]string{
			"1700000100_aaaaaaaa_reth-zisk": `{
				"timestamp": 1700000100,
				"suite_hash": "abc123",
				"instance": {"id": "reth-zisk", "client": "provoor"},
				"metadata": {"labels": {"zkvm": "zisk", "zkvm_version": "v1.3.0-alpha"}},
				"zkvm": "zisk",
				"image": "ghcr.io/eth-act/ere/ere-server-zisk:77e2aae",
				"elf_url": "https://example.com/guest.elf",
				"elf_sha256": "00",
				"tests": {
					"test_a": {"cost": {"base": 1, "main": 10}, "peak_heap_bytes": 7},
					"test_b": {"cost": {"base": 1, "main": 20}}
				},
				"failures": {"test_c": "guest error"}
			}`,
			"1700000200_bbbbbbbb_ethrex-zisk": `{
				"timestamp": 1700000200,
				"image": "ghcr.io/eth-act/ere/ere-server-zisk:0.18.0",
				"tests": {},
				"failures": {"test_a": "guest error"}
			}`,
			"corrupted": `{`,
		} {
			require.NoError(t, os.MkdirAll(filepath.Join(estimatesDir, estimateID), 0755))
			require.NoError(t, os.WriteFile(
				filepath.Join(estimatesDir, estimateID, "result.estimate.json"), []byte(artifact), 0644,
			))
		}

		require.NoError(t, os.Symlink(
			filepath.Join(estimatesDir, "1700000200_bbbbbbbb_ethrex-zisk"),
			filepath.Join(estimatesDir, "1700000200_cccccccc_ethrex-zisk"),
		))
		require.NoError(t, os.Mkdir(filepath.Join(estimatesDir, "empty"), 0755))
		require.NoError(t, os.WriteFile(filepath.Join(estimatesDir, "index.json"), []byte(`{}`), 0644))

		index, err := GenerateEstimateIndex(resultsDir)
		require.NoError(t, err)

		data, err := json.Marshal(index.Entries)
		require.NoError(t, err)
		assert.JSONEq(t, `[
			{
				"estimate_id": "1700000200_bbbbbbbb_ethrex-zisk",
				"timestamp": 1700000200,
				"suite_hash": "",
				"instance": {"id": "", "client": ""},
				"image": "ghcr.io/eth-act/ere/ere-server-zisk:0.18.0",
				"tests": {"tests_passed": 0, "tests_failed": 1},
				"cost": {}
			},
			{
				"estimate_id": "1700000200_cccccccc_ethrex-zisk",
				"timestamp": 1700000200,
				"suite_hash": "",
				"instance": {"id": "", "client": ""},
				"image": "ghcr.io/eth-act/ere/ere-server-zisk:0.18.0",
				"tests": {"tests_passed": 0, "tests_failed": 1},
				"cost": {}
			},
			{
				"estimate_id": "1700000100_aaaaaaaa_reth-zisk",
				"timestamp": 1700000100,
				"suite_hash": "abc123",
				"instance": {"id": "reth-zisk", "client": "provoor"},
				"metadata": {"zkvm": "zisk", "zkvm_version": "v1.3.0-alpha"},
				"image": "ghcr.io/eth-act/ere/ere-server-zisk:77e2aae",
				"tests": {"tests_passed": 2, "tests_failed": 1},
				"cost": {"base": 2, "main": 30}
			}
		]`, string(data))
	})

	t.Run("writes an empty index without an estimates directory", func(t *testing.T) {
		resultsDir := t.TempDir()

		index, err := GenerateEstimateIndex(resultsDir)
		require.NoError(t, err)
		require.NoError(t, WriteEstimateIndex(resultsDir, index, nil))

		data, err := os.ReadFile(filepath.Join(resultsDir, "estimates", "index.json"))
		require.NoError(t, err)
		assert.Contains(t, string(data), `"entries": []`)
	})
}
