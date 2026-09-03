export const clientColors: Record<string, { bg: string; text: string; darkBg: string; darkText: string }> = {
  geth: {
    bg: 'bg-blue-100',
    text: 'text-blue-800',
    darkBg: 'dark:bg-blue-900/50',
    darkText: 'dark:text-blue-200',
  },
  reth: {
    bg: 'bg-orange-100',
    text: 'text-orange-800',
    darkBg: 'dark:bg-orange-900/50',
    darkText: 'dark:text-orange-200',
  },
  nethermind: {
    bg: 'bg-purple-100',
    text: 'text-purple-800',
    darkBg: 'dark:bg-purple-900/50',
    darkText: 'dark:text-purple-200',
  },
  besu: {
    bg: 'bg-green-100',
    text: 'text-green-800',
    darkBg: 'dark:bg-green-900/50',
    darkText: 'dark:text-green-200',
  },
  erigon: {
    bg: 'bg-red-100',
    text: 'text-red-800',
    darkBg: 'dark:bg-red-900/50',
    darkText: 'dark:text-red-200',
  },
  nimbus: {
    bg: 'bg-yellow-100',
    text: 'text-yellow-800',
    darkBg: 'dark:bg-yellow-900/50',
    darkText: 'dark:text-yellow-200',
  },
  ethrex: {
    bg: 'bg-pink-100',
    text: 'text-pink-800',
    darkBg: 'dark:bg-pink-900/50',
    darkText: 'dark:text-pink-200',
  },
  provoor: {
    bg: 'bg-cyan-100',
    text: 'text-cyan-800',
    darkBg: 'dark:bg-cyan-900/50',
    darkText: 'dark:text-cyan-200',
  },
}

/** Extract the base client name from a potentially grouped name like "geth / mainnet". */
export function getBaseClient(client: string): string {
  return client.includes(' / ') ? client.slice(0, client.indexOf(' / ')) : client
}

/** Resolve a client logo URL against the deployment base path. */
export function getClientLogoUrl(client: string): string {
  return `${import.meta.env.BASE_URL}img/clients/${client}.jpg`
}

export function getClientColors(client: string) {
  return (
    clientColors[getBaseClient(client)] ?? {
      bg: 'bg-gray-100',
      text: 'text-gray-800',
      darkBg: 'dark:bg-gray-700',
      darkText: 'dark:text-gray-200',
    }
  )
}

/** Chart hex colors per client (used by ECharts series). */
const clientChartColors: Record<string, string> = {
  geth: '#3b82f6',
  reth: '#f97316',
  nethermind: '#a855f7',
  besu: '#22c55e',
  erigon: '#ef4444',
  nimbus: '#eab308',
  ethrex: '#ec4899',
  provoor: '#06b6d4',
}

const DEFAULT_CHART_COLOR = '#6b7280'

export function getClientChartColor(client: string): string {
  return clientChartColors[getBaseClient(client)] ?? DEFAULT_CHART_COLOR
}

/**
 * Label keys identifying the subject under test for clients whose registry
 * type names the transport rather than the subject.
 */
const subjectLabelKeys: Record<string, string[]> = {
  provoor: ['stateless_validator', 'zkvm'],
}

/**
 * Resolve the name a client badge displays. Clients carrying their subject in
 * metadata labels resolve to the joined label values (e.g. "ethrex-zisk");
 * without metadata a " / key=value, ..." group suffix on the client string is
 * parsed instead. Everything else displays unchanged.
 */
export function getClientDisplayName(client: string, metadata?: Record<string, string>): string {
  const keys = subjectLabelKeys[getBaseClient(client)]
  if (!keys) return client

  if (metadata) {
    const values = keys.map((key) => metadata[key]).filter(Boolean)
    if (values.length > 0) return values.join('-')
  }

  if (client.includes(' / ')) {
    const labels: Record<string, string> = {}
    for (const part of client.slice(client.indexOf(' / ') + 3).split(', ')) {
      const eq = part.indexOf('=')
      if (eq > 0) labels[part.slice(0, eq)] = part.slice(eq + 1)
    }
    const values = keys.map((key) => labels[key]).filter(Boolean)
    if (values.length > 0) return values.join('-')
  }

  return client
}
