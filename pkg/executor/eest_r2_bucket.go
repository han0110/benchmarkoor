package executor

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/ethpandaops/benchmarkoor/pkg/eest"
	"github.com/sirupsen/logrus"
)

// r2BucketManifest is the catalog's manifest.json, reduced to the location of
// the batch index.
type r2BucketManifest struct {
	Paths struct {
		Batches string `json:"batches"`
	} `json:"paths"`
}

// r2BucketBatch is one line of the batch index. Each batch is a tar.zst
// archive of consecutive blocks whose path is relative to the bucket URL.
type r2BucketBatch struct {
	BatchStartBlock uint64 `json:"batchStartBlock"`
	BatchEndBlock   uint64 `json:"batchEndBlock"`
	SHA256          string `json:"sha256"`
	Path            string `json:"path"`
}

// prepareFromR2Bucket downloads the batches that cover the configured block
// range and extracts the blocks inside it. Archives are cached per batch, so a
// later range reuses the downloads it overlaps, and each extracted range is
// cached under its own directory. A height the catalog does not cover is an
// error, so a run never benchmarks fewer heights than configured. A reorged
// height carries more than one block, and only the one in the latest slot is
// kept.
func (s *EESTSource) prepareFromR2Bucket(ctx context.Context) (*PreparedSource, error) {
	first := s.cfg.R2BucketStartingBlock
	last := first + s.cfg.R2BucketBlocks - 1

	cacheBase := filepath.Join(s.cacheDir, "eest-r2-bucket", hashRepoURL(s.cfg.R2BucketURL))
	s.fixturesDir = filepath.Join(cacheBase, fmt.Sprintf("%d-%d", first, last))

	completeMarker := filepath.Join(s.fixturesDir, ".complete")
	if _, err := os.Stat(completeMarker); err == nil {
		s.log.WithField("path", s.fixturesDir).Info("Using cached EEST fixtures")

		return s.discoverTests()
	}

	if err := os.RemoveAll(s.fixturesDir); err != nil {
		return nil, fmt.Errorf("clearing partial fixtures cache: %w", err)
	}

	if err := os.MkdirAll(s.fixturesDir, 0o755); err != nil {
		return nil, fmt.Errorf("creating fixtures directory: %w", err)
	}

	batches, err := s.fetchR2BucketBatches(ctx)
	if err != nil {
		return nil, err
	}

	selected := selectR2BucketBatches(batches, first, last)
	if len(selected) == 0 {
		return nil, fmt.Errorf("r2 bucket %s: no batches cover blocks %d-%d", s.cfg.R2BucketURL, first, last)
	}

	s.log.WithFields(logrus.Fields{
		"blocks":  fmt.Sprintf("%d-%d", first, last),
		"batches": len(selected),
	}).Info("Preparing EEST fixtures from R2 bucket")

	covered := make(map[uint64]struct{}, s.cfg.R2BucketBlocks)

	for _, batch := range selected {
		archivePath := filepath.Join(cacheBase, "archives", filepath.FromSlash(batch.Path))

		if err := s.downloadR2BucketArchive(ctx, batch, archivePath); err != nil {
			return nil, err
		}

		err := extractTarZstFile(archivePath, s.fixturesDir, func(name string) bool {
			block, ok := r2BucketEntryBlock(name)
			if !ok || block < first || block > last {
				return false
			}

			covered[block] = struct{}{}

			return true
		})
		if err != nil {
			return nil, fmt.Errorf("extracting %s: %w", batch.Path, err)
		}
	}

	if missing := s.cfg.R2BucketBlocks - uint64(len(covered)); missing > 0 {
		return nil, fmt.Errorf("r2 bucket %s: blocks %d-%d: %d of %d heights have no fixture",
			s.cfg.R2BucketURL, first, last, missing, s.cfg.R2BucketBlocks)
	}

	if err := s.dropReorgedBlocks(); err != nil {
		return nil, err
	}

	if err := os.WriteFile(completeMarker, nil, 0o644); err != nil {
		return nil, fmt.Errorf("writing cache completion marker: %w", err)
	}

	return s.discoverTests()
}

// dropReorgedBlocks removes every extracted block of a height except the one
// in the latest slot. The witness generator follows the head, so a reorg
// leaves the orphaned block next to the block that replaced it.
func (s *EESTSource) dropReorgedBlocks() error {
	filesByHeight := make(map[uint64][]string)

	err := filepath.WalkDir(s.fixturesDir, func(filePath string, entry os.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}

		if block, ok := r2BucketEntryBlock(filePath); ok {
			filesByHeight[block] = append(filesByHeight[block], filePath)
		}

		return nil
	})
	if err != nil {
		return fmt.Errorf("walking extracted fixtures: %w", err)
	}

	dropped := 0

	for _, files := range filesByHeight {
		if len(files) < 2 {
			continue
		}

		latest, latestSlot := "", uint64(0)

		for _, filePath := range files {
			slot, err := witnessGeneratorSlot(filePath)
			if err != nil {
				return err
			}

			if latest == "" || slot > latestSlot {
				latest, latestSlot = filePath, slot
			}
		}

		for _, filePath := range files {
			if filePath == latest {
				continue
			}

			if err := os.Remove(filePath); err != nil {
				return fmt.Errorf("dropping reorged block: %w", err)
			}

			dropped++
		}
	}

	if dropped > 0 {
		s.log.WithField("count", dropped).Info("Dropped orphaned blocks of reorged heights")
	}

	return nil
}

// witnessGeneratorSlot reads the slot of the single fixture in a catalog file.
func witnessGeneratorSlot(filePath string) (uint64, error) {
	data, err := os.ReadFile(filePath)
	if err != nil {
		return 0, fmt.Errorf("reading fixture: %w", err)
	}

	fixtures, err := eest.ParseFixtureFile(data)
	if err != nil {
		return 0, fmt.Errorf("parsing fixture %s: %w", filePath, err)
	}

	for _, fixture := range fixtures {
		if fixture.Info != nil && fixture.Info.Metadata != nil && fixture.Info.Metadata.WitnessGenerator != nil {
			return fixture.Info.Metadata.WitnessGenerator.SlotNumber, nil
		}
	}

	return 0, fmt.Errorf("fixture %s carries no witness generator slot", filePath)
}

// fetchR2BucketBatches reads the batch index the manifest points at.
func (s *EESTSource) fetchR2BucketBatches(ctx context.Context) ([]r2BucketBatch, error) {
	body, err := s.fetchR2BucketFile(ctx, "manifest.json")
	if err != nil {
		return nil, err
	}

	var manifest r2BucketManifest

	err = json.NewDecoder(body).Decode(&manifest)
	_ = body.Close()

	if err != nil {
		return nil, fmt.Errorf("decoding manifest.json: %w", err)
	}

	if manifest.Paths.Batches == "" {
		return nil, fmt.Errorf("r2 bucket %s: manifest.json names no batch index", s.cfg.R2BucketURL)
	}

	body, err = s.fetchR2BucketFile(ctx, manifest.Paths.Batches)
	if err != nil {
		return nil, err
	}

	defer func() { _ = body.Close() }()

	var batches []r2BucketBatch

	scanner := bufio.NewScanner(body)
	for scanner.Scan() {
		if len(scanner.Bytes()) == 0 {
			continue
		}

		var batch r2BucketBatch
		if err := json.Unmarshal(scanner.Bytes(), &batch); err != nil {
			return nil, fmt.Errorf("decoding %s: %w", manifest.Paths.Batches, err)
		}

		batches = append(batches, batch)
	}

	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("reading %s: %w", manifest.Paths.Batches, err)
	}

	return batches, nil
}

// fetchR2BucketFile GETs a file relative to the bucket URL. The caller closes
// the body.
func (s *EESTSource) fetchR2BucketFile(ctx context.Context, name string) (io.ReadCloser, error) {
	url := s.cfg.R2BucketURL + "/" + name

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return nil, fmt.Errorf("creating request: %w", err)
	}

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, fmt.Errorf("downloading %s: %w", url, err)
	}

	if resp.StatusCode != http.StatusOK {
		_ = resp.Body.Close()

		return nil, fmt.Errorf("downloading %s: HTTP %d", url, resp.StatusCode)
	}

	return resp.Body, nil
}

// selectR2BucketBatches returns the batches overlapping blocks first to last,
// in index order.
func selectR2BucketBatches(batches []r2BucketBatch, first, last uint64) []r2BucketBatch {
	var selected []r2BucketBatch

	for _, batch := range batches {
		if batch.BatchEndBlock >= first && batch.BatchStartBlock <= last {
			selected = append(selected, batch)
		}
	}

	return selected
}

// downloadR2BucketArchive fetches a batch archive into archivePath unless a
// copy with the index's checksum is already there. A download whose checksum
// does not match is removed.
func (s *EESTSource) downloadR2BucketArchive(ctx context.Context, batch r2BucketBatch, archivePath string) error {
	want := strings.TrimPrefix(batch.SHA256, "0x")

	if got, err := fileSHA256(archivePath); err == nil && got == want {
		s.log.WithField("path", archivePath).Debug("Using cached batch archive")

		return nil
	}

	if err := os.MkdirAll(filepath.Dir(archivePath), 0o755); err != nil {
		return fmt.Errorf("creating archive cache directory: %w", err)
	}

	url := s.cfg.R2BucketURL + "/" + batch.Path

	if err := downloadToFile(ctx, url, archivePath, "", s.log.WithField("batch", path.Base(batch.Path))); err != nil {
		return fmt.Errorf("downloading %s: %w", url, err)
	}

	got, err := fileSHA256(archivePath)
	if err != nil {
		return fmt.Errorf("verifying %s: %w", url, err)
	}

	if got != want {
		_ = os.Remove(archivePath)

		return fmt.Errorf("downloading %s: sha256 mismatch, want %s, got %s", url, want, got)
	}

	return nil
}

// r2BucketEntryBlock reads the block number from a fixture entry named
// <number>-<hash>.json, the layout the catalog writes its fixtures in.
func r2BucketEntryBlock(name string) (uint64, bool) {
	number, rest, ok := strings.Cut(path.Base(name), "-")
	if !ok || !strings.HasSuffix(rest, ".json") {
		return 0, false
	}

	block, err := strconv.ParseUint(number, 10, 64)
	if err != nil {
		return 0, false
	}

	return block, true
}
