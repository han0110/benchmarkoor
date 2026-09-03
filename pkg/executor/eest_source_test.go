package executor

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/ethpandaops/benchmarkoor/pkg/config"
	"github.com/ethpandaops/benchmarkoor/pkg/eest"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFindMetaDir(t *testing.T) {
	// Nested fixtures (e.g. a build artifact): fixtures_subdir resolves to
	// <root>/a/b/blockchain_tests; .meta is a sibling at <root>/a/b/.meta.
	root := t.TempDir()
	nested := filepath.Join(root, "a", "b")
	require.NoError(t, os.MkdirAll(filepath.Join(nested, "blockchain_tests"), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(nested, ".meta"), 0o755))
	assert.Equal(t, filepath.Join(nested, ".meta"),
		findMetaDir(filepath.Join(nested, "blockchain_tests"), root),
		"prefers the .meta sibling of the resolved fixtures dir")

	// Root-level fallback: .meta only at the fixtures-cache root.
	root2 := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(root2, "fixtures", "blockchain_tests"), 0o755))
	require.NoError(t, os.MkdirAll(filepath.Join(root2, ".meta"), 0o755))
	assert.Equal(t, filepath.Join(root2, ".meta"),
		findMetaDir(filepath.Join(root2, "fixtures", "blockchain_tests"), root2),
		"falls back to the fixtures-cache root")

	// No .meta anywhere.
	assert.Empty(t, findMetaDir(filepath.Join(t.TempDir(), "x"), t.TempDir()))
}

func TestStatefulPreRunMissing(t *testing.T) {
	tests := []struct {
		name      string
		startHash string
		snapHash  string
		want      bool
	}{
		{
			name:      "start ahead of snapshot warns",
			startHash: "0xstart",
			snapHash:  "0xsnapshot",
			want:      true,
		},
		{
			name:      "start equals snapshot is silent",
			startHash: "0xsnapshot",
			snapHash:  "0xsnapshot",
			want:      false,
		},
		{
			name:      "empty start block is silent",
			startHash: "",
			snapHash:  "0xsnapshot",
			want:      false,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			f := &eest.Fixture{StartBlockHash: tt.startHash, SnapshotBlockHash: tt.snapHash}
			assert.Equal(t, tt.want, statefulPreRunMissing(f))
		})
	}
}

func TestParseGitHubArtifactURL(t *testing.T) {
	owner, repo, id, ok := parseGitHubArtifactURL(
		"https://github.com/ethpandaops/benchmarkoor/actions/runs/28947560261/artifacts/8170387928",
	)
	assert.True(t, ok)
	assert.Equal(t, "ethpandaops", owner)
	assert.Equal(t, "benchmarkoor", repo)
	assert.Equal(t, "8170387928", id)

	// A plain release / tarball URL is not an artifact URL.
	_, _, _, ok = parseGitHubArtifactURL(
		"https://github.com/ethpandaops/benchmarkoor-tests/releases/download/untagged-x/fixtures.tar.gz",
	)
	assert.False(t, ok)

	_, _, _, ok = parseGitHubArtifactURL("https://example.com/fixtures.tar.gz")
	assert.False(t, ok)
}

func TestLoadPreRunBundleSteps(t *testing.T) {
	// writeBundle creates <root>/<subdir>/pre-run.request and returns root.
	writeBundle := func(t *testing.T, subdir string) string {
		t.Helper()

		root := t.TempDir()
		dir := filepath.Join(root, subdir)
		require.NoError(t, os.MkdirAll(dir, 0o755))
		require.NoError(t, os.WriteFile(filepath.Join(dir, "pre-run.request"), []byte("{}\n"), 0o644))

		return root
	}

	t.Run("no pre_runs source is a no-op", func(t *testing.T) {
		s := &EESTSource{log: logrus.New(), cfg: &config.EESTFixturesSource{}}
		steps, err := s.loadPreRunBundleSteps()
		require.NoError(t, err)
		assert.Nil(t, steps)
	})

	t.Run("nothing to resolve against is a no-op", func(t *testing.T) {
		// pre_runs configured, but neither a local dir nor extracted fixtures.
		s := &EESTSource{
			log: logrus.New(),
			cfg: &config.EESTFixturesSource{PreRuns: &config.EESTPreRunsSource{}},
		}
		steps, err := s.loadPreRunBundleSteps()
		require.NoError(t, err)
		assert.Nil(t, steps)
	})

	t.Run("local_fixtures_dir wins over the extracted fixtures", func(t *testing.T) {
		local := writeBundle(t, config.PreRunBundleSubdir)
		s := &EESTSource{
			log:         logrus.New(),
			fixturesDir: t.TempDir(), // no bundle here — must not be consulted
			cfg: &config.EESTFixturesSource{
				PreRuns: &config.EESTPreRunsSource{LocalFixturesDir: local},
			},
		}

		steps, err := s.loadPreRunBundleSteps()
		require.NoError(t, err)
		require.Len(t, steps, 1)
		assert.Equal(t, filepath.Join(local, config.PreRunBundleSubdir, "pre-run.request"), steps[0].Path)
	})

	t.Run("falls back to the extracted fixtures artifact", func(t *testing.T) {
		// The layout a benchmarkoor build ships: fixtures and bundle in one
		// tarball, the bundle addressed by a subdir under the extract root.
		subdir := filepath.Join("benchmarkoor-build-artifacts", "pre-runs", "geth", "pre_run_bundle")
		root := writeBundle(t, subdir)
		s := &EESTSource{
			log:         logrus.New(),
			fixturesDir: root,
			cfg: &config.EESTFixturesSource{
				PreRuns: &config.EESTPreRunsSource{FixturesSubdir: subdir},
			},
		}

		steps, err := s.loadPreRunBundleSteps()
		require.NoError(t, err)
		require.Len(t, steps, 1)
		assert.Equal(t, filepath.Join(root, subdir, "pre-run.request"), steps[0].Path)
		assert.Equal(t, "pre_run/pre-run.request", steps[0].Name)
	})

	t.Run("subdir defaults to the bundle subdir under the artifact", func(t *testing.T) {
		root := writeBundle(t, config.PreRunBundleSubdir)
		s := &EESTSource{
			log:         logrus.New(),
			fixturesDir: root,
			cfg:         &config.EESTFixturesSource{PreRuns: &config.EESTPreRunsSource{}},
		}

		steps, err := s.loadPreRunBundleSteps()
		require.NoError(t, err)
		require.Len(t, steps, 1)
	})

	t.Run("a configured bundle that is missing is an error", func(t *testing.T) {
		s := &EESTSource{
			log:         logrus.New(),
			fixturesDir: t.TempDir(),
			cfg: &config.EESTFixturesSource{
				PreRuns: &config.EESTPreRunsSource{FixturesSubdir: "nope"},
			},
		}

		_, err := s.loadPreRunBundleSteps()
		require.Error(t, err)
		assert.Contains(t, err.Error(), "no pre-run bundle")
	})
}

func TestPreRunBundleDir(t *testing.T) {
	tests := []struct {
		name        string
		preRuns     *config.EESTPreRunsSource
		fixturesDir string
		want        func(fixtures string) string
	}{
		{
			name:    "no pre_runs source",
			preRuns: nil,
			want:    func(string) string { return "" },
		},
		{
			name:    "nothing to resolve against",
			preRuns: &config.EESTPreRunsSource{},
			want:    func(string) string { return "" },
		},
		{
			name:        "local dir wins over the extracted artifact",
			preRuns:     &config.EESTPreRunsSource{LocalFixturesDir: "/local"},
			fixturesDir: "/artifact",
			want:        func(string) string { return filepath.Join("/local", config.PreRunBundleSubdir) },
		},
		{
			name:        "falls back to the extracted artifact",
			preRuns:     &config.EESTPreRunsSource{FixturesSubdir: "a/b/pre_run_bundle"},
			fixturesDir: "/artifact",
			want:        func(string) string { return filepath.Join("/artifact", "a/b/pre_run_bundle") },
		},
		{
			name:        "subdir defaults under the artifact",
			preRuns:     &config.EESTPreRunsSource{},
			fixturesDir: "/artifact",
			want:        func(string) string { return filepath.Join("/artifact", config.PreRunBundleSubdir) },
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			s := &EESTSource{
				log:         logrus.New(),
				fixturesDir: tt.fixturesDir,
				cfg:         &config.EESTFixturesSource{PreRuns: tt.preRuns},
			}
			assert.Equal(t, tt.want(tt.fixturesDir), s.PreRunBundleDir())
		})
	}

	// The locator is what lets a caller outside this package find the bundle
	// without re-deriving it from config.
	var _ PreRunBundleLocator = (*EESTSource)(nil)
}

// discoverStatelessFixture runs discovery over the multi-block fixture the eest
// package vendors, reused so both packages assert against one copy of the real
// data.
func discoverStatelessFixture(t *testing.T) *PreparedSource {
	t.Helper()

	fixture, err := os.ReadFile(filepath.Join("..", "eest", "testdata", "parallel_execution_serial_chain.json"))
	require.NoError(t, err)

	const subdir = "fixtures/blockchain_tests"

	fixturesDir := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(fixturesDir, subdir), 0755))
	require.NoError(t, os.WriteFile(filepath.Join(fixturesDir, subdir, "serial_chain.json"), fixture, 0644))

	filter, err := CompileFilter("")
	require.NoError(t, err)

	log := logrus.New()
	log.SetOutput(os.Stderr)
	log.SetLevel(logrus.ErrorLevel)

	source := NewEESTSource(log, &config.EESTFixturesSource{FixturesSubdir: subdir}, t.TempDir(), filter, "")
	source.fixturesDir = fixturesDir

	prepared, err := source.discoverTests()
	require.NoError(t, err)
	require.Len(t, prepared.Tests, 1)

	return prepared
}

// TestDiscoverStatelessOpcodeCount pins the suite-facing shape of a stateless
// fixture's opcode data. Counts reach the same field external opcode sources
// use, and the embedded _info keeps neither the derived map nor the per-block
// list it came from, so the output matches what other fixture formats produce.
func TestDiscoverStatelessOpcodeCount(t *testing.T) {
	discovered := discoverStatelessFixture(t).Tests[0]

	// The benchmark block's own counts, matching pkg/eest's assertions.
	require.NotNil(t, discovered.OpcodeCount)
	assert.Equal(t, 38924, discovered.OpcodeCount["PUSH1"])
	assert.NotContains(t, discovered.OpcodeCount, "CODECOPY")

	require.NotNil(t, discovered.EESTInfo)
	assert.Nil(t, discovered.EESTInfo.OpcodeCount)
	require.NotNil(t, discovered.EESTInfo.Metadata)
	assert.Nil(t, discovered.EESTInfo.Metadata.OpcodeCountPerBlock)
}

// TestSuiteSummaryStatelessOpcodeShape asserts the raw summary.json keys rather
// than the decoded structs, because the frontend reads the document as written.
// A stateless test keeps opcode_count where every consumer looks for it and
// carries no second copy inside eest.info.
func TestSuiteSummaryStatelessOpcodeShape(t *testing.T) {
	prepared := discoverStatelessFixture(t)

	resultsDir := t.TempDir()
	log := logrus.New()
	log.SetOutput(os.Stderr)
	log.SetLevel(logrus.ErrorLevel)

	require.NoError(t, CreateSuiteOutput(log, resultsDir, "statel3ss", &SuiteInfo{Hash: "statel3ss"}, prepared, nil, 0))

	data, err := os.ReadFile(filepath.Join(resultsDir, "suites", "statel3ss", "summary.json"))
	require.NoError(t, err)

	var summary struct {
		Tests []map[string]any `json:"tests"`
	}
	require.NoError(t, json.Unmarshal(data, &summary))
	require.Len(t, summary.Tests, 1)

	test := summary.Tests[0]

	counts, ok := test["opcode_count"].(map[string]any)
	require.True(t, ok, "summary.json must keep test.opcode_count")
	assert.EqualValues(t, 38924, counts["PUSH1"])

	info, ok := test["eest"].(map[string]any)["info"].(map[string]any)
	require.True(t, ok)
	assert.NotContains(t, info, "opcode_count")
	assert.NotContains(t, info["metadata"], "opcode_count_per_block")
}
