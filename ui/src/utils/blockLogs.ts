// Shared reading of block logs whose producer measures proving rather than
// execution. Proving clients report only a total time, so treating the missing
// execution breakdown as zero would show an execution stage that never ran.
//
// The subject is read from the run configuration rather than from the block
// logs, matching how execution clients are identified: their payloads carry
// measurements only, and the client is named once per run.
import type { BlockLogEntry, RunConfig } from '@/api/types'

/** Clients whose measured work is proving a block rather than executing it. */
const provingClients = new Set(['provoor'])

/** Reports whether a run's client proves blocks rather than executing them. */
export function isProvingRun(config: RunConfig | null | undefined): boolean {
  return config != null && provingClients.has(config.instance.client)
}

/** Names the measured time, "Proving" or "Execution". */
export function measuredTimeLabel(isProving: boolean): string {
  return isProving ? 'Proving' : 'Execution'
}

/** The measured time of one entry, in milliseconds. */
export function measuredTimeMs(entry: BlockLogEntry, isProving: boolean): number {
  return (isProving ? entry.timing?.total_ms : entry.timing?.execution_ms) ?? 0
}
