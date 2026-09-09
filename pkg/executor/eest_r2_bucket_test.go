package executor

import (
	"archive/tar"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/ethpandaops/benchmarkoor/pkg/config"
	"github.com/klauspost/compress/zstd"
	"github.com/sirupsen/logrus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestSelectR2BucketBatches(t *testing.T) {
	batches := []r2BucketBatch{
		{BatchStartBlock: 100, BatchEndBlock: 109, Path: "exports/batches/100-109.tar.zst"},
		{BatchStartBlock: 110, BatchEndBlock: 119, Path: "exports/batches/110-119.tar.zst"},
		{BatchStartBlock: 120, BatchEndBlock: 129, Path: "exports/batches/120-129.tar.zst"},
	}

	tests := []struct {
		name  string
		first uint64
		last  uint64
		want  []string
	}{
		{name: "inside one batch", first: 112, last: 115, want: []string{"exports/batches/110-119.tar.zst"}},
		{name: "spanning two batches", first: 108, last: 111, want: []string{
			"exports/batches/100-109.tar.zst", "exports/batches/110-119.tar.zst",
		}},
		{name: "past the last batch", first: 130, last: 139, want: nil},
		{name: "before the first batch", first: 90, last: 99, want: nil},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			var got []string
			for _, b := range selectR2BucketBatches(batches, tt.first, tt.last) {
				got = append(got, b.Path)
			}

			assert.Equal(t, tt.want, got)
		})
	}
}

func TestR2BucketEntryBlock(t *testing.T) {
	block, ok := r2BucketEntryBlock("blockchain_tests/000093/93300-70c0d887.json")
	require.True(t, ok)
	assert.Equal(t, uint64(93300), block)

	_, ok = r2BucketEntryBlock(".meta/manifest.json")
	assert.False(t, ok)

	_, ok = r2BucketEntryBlock("blockchain_tests/000093/manifest.json")
	assert.False(t, ok)
}

// witnessGeneratorFixture renders a minimal catalog fixture for one block, in
// the shape the witness generator writes. The hash seed tells two blocks at
// the same height apart, and the slot orders them.
func witnessGeneratorFixture(block, hashSeed, slot uint64) []byte {
	hash := fmt.Sprintf("0x%064x", hashSeed)
	name := fmt.Sprintf("witness-generator-spec-cli::block_%d_%s", block, hash[2:])

	fixture := map[string]any{
		name: map[string]any{
			"network": "Amsterdam",
			"config":  map[string]string{"chainid": "0x1"},
			"blocks": []map[string]any{{
				"statelessInputBytes":  "0x1501",
				"statelessOutputBytes": "0x01",
				"blockHeader":          map[string]string{"number": fmt.Sprintf("0x%x", block), "gasUsed": "0x10"},
			}},
			"_info": map[string]any{
				"metadata": map[string]any{
					"witness_generator": map[string]any{"network": "devnet", "blockHash": hash, "slotNumber": slot},
				},
			},
		},
	}

	data, err := json.Marshal(fixture)
	if err != nil {
		panic(err)
	}

	return data
}

// reorgedHeight is a height the fake catalog holds two blocks for, as a devnet
// reorg leaves behind. The orphaned block sits in the later archive entry but
// the earlier slot, so entry order does not decide which block survives.
const reorgedHeight = 105

// r2BucketBatchArchive builds a tar.zst batch archive covering [first, last]
// with the catalog's .meta/manifest.json sibling.
func r2BucketBatchArchive(t *testing.T, first, last uint64) []byte {
	t.Helper()

	var buf bytes.Buffer

	zw, err := zstd.NewWriter(&buf)
	require.NoError(t, err)

	tw := tar.NewWriter(zw)

	add := func(name string, data []byte) {
		require.NoError(t, tw.WriteHeader(&tar.Header{Name: name, Mode: 0o644, Size: int64(len(data))}))
		_, err := tw.Write(data)
		require.NoError(t, err)
	}

	add(".meta/manifest.json", []byte(fmt.Sprintf(`{"batchStartBlock":%d,"batchEndBlock":%d}`, first, last)))

	for block := first; block <= last; block++ {
		add(fmt.Sprintf("blockchain_tests/%06d/%d-%064x.json", block/1000, block, block), witnessGeneratorFixture(block, block, 2*block))

		if block == reorgedHeight {
			seed := block + 1_000_000
			add(fmt.Sprintf("blockchain_tests/%06d/%d-%064x.json", block/1000, block, seed), witnessGeneratorFixture(block, seed, 2*block-1))
		}
	}

	require.NoError(t, tw.Close())
	require.NoError(t, zw.Close())

	return buf.Bytes()
}

// fakeR2Bucket serves a catalog of three ten-block batches from 100 and counts
// archive downloads.
type fakeR2Bucket struct {
	server           *httptest.Server
	archiveDownloads atomic.Int32
	corruptBatch     string
}

func newFakeR2Bucket(t *testing.T) *fakeR2Bucket {
	t.Helper()

	bucket := &fakeR2Bucket{}
	archives := map[string][]byte{}
	index := &bytes.Buffer{}

	for first := uint64(100); first < 130; first += 10 {
		data := r2BucketBatchArchive(t, first, first+9)
		path := fmt.Sprintf("exports/batches/%d-%d.tar.zst", first, first+9)
		archives[path] = data
		sum := sha256.Sum256(data)

		fmt.Fprintf(index, `{"batchStartBlock":%d,"batchEndBlock":%d,"sha256":"0x%s","path":"%s"}`+"\n",
			first, first+9, hex.EncodeToString(sum[:]), path)
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/devnets/devnet-8/manifest.json", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"kind":"stateless-inputs-public-catalog","paths":{"batches":"batches.jsonl"}}`))
	})
	mux.HandleFunc("/devnets/devnet-8/batches.jsonl", func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(index.Bytes())
	})
	mux.HandleFunc("/devnets/devnet-8/exports/batches/", func(w http.ResponseWriter, r *http.Request) {
		path := strings.TrimPrefix(r.URL.Path, "/devnets/devnet-8/")

		data, ok := archives[path]
		if !ok {
			http.NotFound(w, r)

			return
		}

		if r.Method == http.MethodGet {
			bucket.archiveDownloads.Add(1)
		}

		if path == bucket.corruptBatch {
			data = append([]byte("corrupt"), data...)
		}

		http.ServeContent(w, r, path, time.Time{}, bytes.NewReader(data))
	})

	bucket.server = httptest.NewServer(mux)
	t.Cleanup(bucket.server.Close)

	return bucket
}

func (b *fakeR2Bucket) source(t *testing.T, cacheDir string, startingBlock, blocks uint64) *EESTSource {
	t.Helper()

	cfg := &config.EESTFixturesSource{
		R2BucketURL:           b.server.URL + "/devnets/devnet-8",
		R2BucketStartingBlock: startingBlock,
		R2BucketBlocks:        blocks,
		FixturesSubdir:        config.DefaultR2BucketFixturesSubdir,
	}

	return NewEESTSource(logrus.New(), cfg, cacheDir, nil, "")
}

func TestEESTSource_PrepareFromR2Bucket(t *testing.T) {
	bucket := newFakeR2Bucket(t)
	cacheDir := t.TempDir()

	prepared, err := bucket.source(t, cacheDir, 108, 4).Prepare(context.Background())
	require.NoError(t, err)

	// Blocks 108 to 111 span the first two batches. The third is never fetched.
	assert.Equal(t, int32(2), bucket.archiveDownloads.Load())

	var names []string
	for _, test := range prepared.Tests {
		names = append(names, test.Name)
	}

	assert.Equal(t, []string{
		fmt.Sprintf("witness-generator-spec-cli::block_108_%064x", 108),
		fmt.Sprintf("witness-generator-spec-cli::block_109_%064x", 109),
		fmt.Sprintf("witness-generator-spec-cli::block_110_%064x", 110),
		fmt.Sprintf("witness-generator-spec-cli::block_111_%064x", 111),
	}, names)

	assert.Empty(t, prepared.MetaDir, "the batch .meta dir is not an EEST fill .meta dir")

	// Only the requested blocks are extracted.
	extracted, err := filepath.Glob(filepath.Join(prepared.BasePath, "*", "*.json"))
	require.NoError(t, err)
	assert.Len(t, extracted, 4)

	// The same range is served from the cache, and a neighbouring range reuses
	// the cached archives it overlaps.
	_, err = bucket.source(t, cacheDir, 108, 4).Prepare(context.Background())
	require.NoError(t, err)
	assert.Equal(t, int32(2), bucket.archiveDownloads.Load())

	prepared, err = bucket.source(t, cacheDir, 111, 10).Prepare(context.Background())
	require.NoError(t, err)
	assert.Equal(t, int32(3), bucket.archiveDownloads.Load())
	assert.Len(t, prepared.Tests, 10)
}

func TestEESTSource_PrepareFromR2Bucket_SourceInfo(t *testing.T) {
	bucket := newFakeR2Bucket(t)
	source := bucket.source(t, t.TempDir(), 100, 5)

	_, err := source.Prepare(context.Background())
	require.NoError(t, err)

	info, err := source.GetSourceInfo()
	require.NoError(t, err)
	require.NotNil(t, info.EEST)
	assert.Equal(t, bucket.server.URL+"/devnets/devnet-8", info.EEST.R2BucketURL)
	assert.Equal(t, uint64(100), info.EEST.R2BucketStartingBlock)
	assert.Equal(t, uint64(5), info.EEST.R2BucketBlocks)
	assert.Equal(t, "blockchain_tests", info.EEST.FixturesSubdir)
}

func TestEESTSource_PrepareFromR2Bucket_ChecksumMismatch(t *testing.T) {
	bucket := newFakeR2Bucket(t)
	bucket.corruptBatch = "exports/batches/110-119.tar.zst"
	cacheDir := t.TempDir()

	_, err := bucket.source(t, cacheDir, 105, 10).Prepare(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "sha256 mismatch")

	// A corrupt archive is not left in the cache.
	entries, err := os.ReadDir(filepath.Join(cacheDir, "eest-r2-bucket"))
	require.NoError(t, err)
	require.Len(t, entries, 1)

	_, err = os.Stat(filepath.Join(cacheDir, "eest-r2-bucket", entries[0].Name(), "archives", "exports", "batches", "110-119.tar.zst"))
	assert.True(t, os.IsNotExist(err))
}

func TestEESTSource_PrepareFromR2Bucket_PastCatalogHead(t *testing.T) {
	bucket := newFakeR2Bucket(t)
	cacheDir := t.TempDir()

	// Blocks 125 to 134 overlap the last batch, which ends at 129.
	_, err := bucket.source(t, cacheDir, 125, 10).Prepare(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "blocks 125-134: 5 of 10 heights have no fixture")

	// A short range is not cached, so a later run sees a grown catalog.
	markers, err := filepath.Glob(filepath.Join(cacheDir, "eest-r2-bucket", "*", "125-134", ".complete"))
	require.NoError(t, err)
	assert.Empty(t, markers)
}

func TestEESTSource_PrepareFromR2Bucket_NoBatches(t *testing.T) {
	bucket := newFakeR2Bucket(t)

	_, err := bucket.source(t, t.TempDir(), 500, 10).Prepare(context.Background())
	require.Error(t, err)
	assert.Contains(t, err.Error(), "no batches cover blocks 500-509")
}

func TestEESTSource_PrepareFromR2Bucket_ReorgedHeight(t *testing.T) {
	bucket := newFakeR2Bucket(t)

	prepared, err := bucket.source(t, t.TempDir(), 104, 3).Prepare(context.Background())
	require.NoError(t, err)

	// Only the block in the later slot survives at the reorged height.
	var names []string
	for _, test := range prepared.Tests {
		names = append(names, test.Name)
	}

	assert.Equal(t, []string{
		fmt.Sprintf("witness-generator-spec-cli::block_104_%064x", 104),
		fmt.Sprintf("witness-generator-spec-cli::block_105_%064x", 105),
		fmt.Sprintf("witness-generator-spec-cli::block_106_%064x", 106),
	}, names)

	extracted, err := filepath.Glob(filepath.Join(prepared.BasePath, "*", "*.json"))
	require.NoError(t, err)
	assert.Len(t, extracted, 3)
}
