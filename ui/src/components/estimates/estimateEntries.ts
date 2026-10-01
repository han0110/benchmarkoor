import type { EstimateIndexEntry, RunConfig, RunEstimate } from '@/api/types'
import { MAX_COMPARE_RUNS, type CompareRun } from '@/components/compare/constants'
import type { SortDirection } from '@/components/runs/sortEntries'
import { getClientDisplayName } from '@/utils/client-colors'
import { costTotal, sortNullsLast } from '@/utils/estimate'

export type EstimateSortColumn = 'timestamp' | 'subject' | 'version' | 'image' | 'suite' | 'failed' | 'passed' | 'total' | 'cost'

/** The mean cost of a passed test, null where no test passed. */
export function meanCost(entry: EstimateIndexEntry): number | null {
  return entry.tests.tests_passed > 0 ? costTotal(entry.cost) / entry.tests.tests_passed : null
}

/** The tag of the image, the part after its last colon. */
export const imageTag = (image: string): string => image.slice(image.lastIndexOf(':') + 1)

const sortValue = (entry: EstimateIndexEntry, column: EstimateSortColumn, suiteSizes: Map<string, number>): number | string | null => {
  switch (column) {
    case 'timestamp':
      return entry.timestamp
    case 'subject':
      return getClientDisplayName(entry.instance.client, entry.metadata)
    case 'version':
      return entry.metadata?.zkvm_version ?? null
    case 'image':
      return entry.image
    case 'suite':
      return entry.suite_hash
    case 'failed':
      return entry.tests.tests_failed
    case 'passed':
      return entry.tests.tests_passed
    case 'total':
      return suiteSizes.get(entry.suite_hash) ?? null
    case 'cost':
      return meanCost(entry)
  }
}

/**
 * The entries in the order of the sort, an entry without the value going last
 * whichever way the column runs. The suite sizes are keyed by suite hash.
 */
export function sortEstimates(
  entries: EstimateIndexEntry[],
  sortBy: EstimateSortColumn,
  sortDir: SortDirection,
  suiteSizes: Map<string, number>,
): EstimateIndexEntry[] {
  return sortNullsLast(entries, (entry) => sortValue(entry, sortBy, suiteSizes), sortDir)
}

/** The reason the entry cannot join the selection, undefined where it can. Costs share one scale only within one zkVM. */
export function selectionBlocker(entry: EstimateIndexEntry, selection: EstimateIndexEntry[]): string | undefined {
  if (selection.some((picked) => picked.estimate_id === entry.estimate_id)) return undefined
  if (selection.length >= MAX_COMPARE_RUNS) return `Cannot compare more than ${MAX_COMPARE_RUNS} estimates`
  if (selection.length > 0 && entry.metadata?.zkvm !== selection[0].metadata?.zkvm) return 'Cannot compare costs across zkVMs'
  return undefined
}

/** Reports whether the selection holds estimates of more than one suite. */
export function spansSuites(selection: EstimateIndexEntry[]): boolean {
  return new Set(selection.map((picked) => picked.suite_hash)).size > 1
}

/** Reports whether the selection holds estimates of more than one ere tag. */
export function spansEreTags(selection: EstimateIndexEntry[]): boolean {
  return new Set(selection.map((picked) => imageTag(picked.image))).size > 1
}

/** Every label key of the entries with its values in order, for the label filters. */
export function availableLabels(entries: EstimateIndexEntry[]): Map<string, string[]> {
  const valuesByKey = new Map<string, Set<string>>()
  for (const entry of entries) {
    for (const [key, value] of Object.entries(entry.metadata ?? {})) {
      const values = valuesByKey.get(key) ?? new Set<string>()
      valuesByKey.set(key, values.add(value))
    }
  }
  return new Map([...valuesByKey].map(([key, values]) => [key, [...values].sort()]))
}

/**
 * The compare run of an estimate. Its config holds only the header of the
 * estimate, because the compare panels read no more than the instance and the
 * labels of a run.
 */
export function estimateCompareRun(estimateId: string, estimate: RunEstimate, index: number): CompareRun {
  const { timestamp, suite_hash, instance, metadata } = estimate
  return { runId: estimateId, config: { timestamp, suite_hash, instance, metadata } as RunConfig, result: null, index }
}
