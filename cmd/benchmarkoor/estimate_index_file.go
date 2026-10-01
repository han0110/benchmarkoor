package main

import (
	"fmt"

	"github.com/ethpandaops/benchmarkoor/pkg/executor"
	"github.com/spf13/cobra"
)

var estimateIndexResultsDir string

var estimateIndexFileCmd = &cobra.Command{
	Use:   "generate-estimate-index-file",
	Short: "Generate index.json from all estimates in results directory",
	Long: `Scan all estimates/*/result.estimate.json files to generate
an estimates/index.json summary.`,
	RunE: runEstimateIndexFile,
}

func init() {
	rootCmd.AddCommand(estimateIndexFileCmd)
	estimateIndexFileCmd.Flags().StringVar(
		&estimateIndexResultsDir, "results-dir", "",
		"Path to the results directory",
	)

	if err := estimateIndexFileCmd.MarkFlagRequired("results-dir"); err != nil {
		panic(err)
	}
}

func runEstimateIndexFile(_ *cobra.Command, _ []string) error {
	index, err := executor.GenerateEstimateIndex(estimateIndexResultsDir)
	if err != nil {
		return fmt.Errorf("generating estimate index: %w", err)
	}

	if err := executor.WriteEstimateIndex(estimateIndexResultsDir, index, nil); err != nil {
		return fmt.Errorf("writing estimate index: %w", err)
	}

	log.WithField("entries_count", len(index.Entries)).
		Info("estimates/index.json generated successfully")

	return nil
}
