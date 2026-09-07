import { useMemo } from 'react'
import type { DeviceMetrics } from '@/api/types'
import { COLUMN } from '@/utils/gpuMetrics'
import { NODE_COLUMN, coreCount } from '@/utils/nodeMetrics'
import { GAUGE_SCALE, LEADING, columnReader, higher, host, scaled, type Row } from '@/utils/remoteMetrics'

const GIB = 1024 ** 3

interface ClusterConfigurationProps {
  /** The node exporter artifact, absent from a run that collected none. */
  nodeMetrics?: DeviceMetrics | null
  /** The DCGM exporter artifact, absent from a run that collected none. */
  deviceMetrics?: DeviceMetrics | null
}

/** One device of the cluster and the static facts its rows carry. */
interface DeviceFacts {
  host: string
  value: string
}

/** One line of the sub-section, which describes the devices that share a specification. */
interface ClusterItemProps {
  label: string
  value: string
}

function ClusterItem({ label, value }: ClusterItemProps) {
  return (
    <div>
      <dt className="text-xs/5 font-medium text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="mt-1 text-sm/6 text-gray-900 dark:text-gray-100">{value}</dd>
    </div>
  )
}

/** The rows of an artifact grouped by the device that reported them. */
function rowsByDevice(metrics: DeviceMetrics, cell: (row: Row, name: string) => number | null): Row[][] {
  const groups = metrics.devices.map((): Row[] => [])

  for (const blocks of Object.values(metrics.tests)) {
    for (const rows of Object.values(blocks)) {
      for (const row of rows) {
        const device = cell(row, LEADING.device)
        if (device !== null) groups[device].push(row)
      }
    }
  }

  return groups
}

/** The measured facts of one device, joined into a line. An unmeasured fact is left out. */
const line = (parts: Array<string | null>) => parts.filter((part) => part !== null).join(', ')

/**
 * nodeFacts reads the size of each node. The processor count comes from the
 * seconds the node counted over the seconds a block took, as the CPU scale of
 * the charts does. The RAM is read to whole GiB, because nodes of one model
 * report totals that differ by some MiB and must still group together.
 */
function nodeFacts(metrics: DeviceMetrics): DeviceFacts[] {
  const { cell } = columnReader(metrics)

  return rowsByDevice(metrics, cell).map((rows, index) => {
    let cores: number | null = null
    let ramTotalGiB: number | null = null

    for (const row of rows) {
      const durationMs = cell(row, LEADING.durationMs) ?? 0
      const seconds = cell(row, NODE_COLUMN.cpuAll)
      if (seconds !== null && durationMs > 0) cores = higher(cores, coreCount(seconds / GAUGE_SCALE, durationMs))
      ramTotalGiB = higher(ramTotalGiB, scaled(cell(row, NODE_COLUMN.memTotal), 1 / GAUGE_SCALE / GIB))
    }

    return {
      host: host(metrics.devices[index]),
      value: line([cores === null ? null : `${cores} processors`, ramTotalGiB === null ? null : `${Math.round(ramTotalGiB)} GiB RAM`]),
    }
  })
}

/** gpuFacts reads the model and the size of each GPU. The exporter reports the frame buffer in MiB. */
function gpuFacts(metrics: DeviceMetrics): DeviceFacts[] {
  const { cell } = columnReader(metrics)

  return rowsByDevice(metrics, cell).map((rows, index) => {
    const device = metrics.devices[index]
    let frameBufferGiB: number | null = null
    let powerLimit: number | null = null

    for (const row of rows) {
      frameBufferGiB = higher(frameBufferGiB, scaled(cell(row, COLUMN.fbTotal), 1 / GAUGE_SCALE / 1024))
      powerLimit = higher(powerLimit, scaled(cell(row, COLUMN.powerLimit), 1 / GAUGE_SCALE))
    }

    return {
      host: host(device),
      value: line([
        device.labels.modelName ?? null,
        frameBufferGiB === null ? null : `${frameBufferGiB.toFixed(1)} GiB frame buffer`,
        powerLimit === null ? null : `${powerLimit.toFixed(0)} W cap`,
      ]),
    }
  })
}

/** The devices each host carries, named only when every host of the group carries the same count. */
function perNode(hosts: string[]): string {
  const counts = [...new Set(hosts)].map((name) => hosts.filter((other) => other === name).length)

  return counts.every((count) => count === counts[0]) ? `, ${counts[0]} per node` : ''
}

/**
 * clusterItems folds the devices that report the same facts into one item per
 * specification. The count leads the value, and the hosts follow it when the
 * cluster mixes specifications.
 */
function clusterItems(devices: DeviceFacts[], label: string, detail?: (hosts: string[]) => string): ClusterItemProps[] {
  const specs = new Map<string, string[]>()
  for (const device of devices) {
    if (device.value !== '') specs.set(device.value, [...(specs.get(device.value) ?? []), device.host])
  }

  const groups = [...specs]

  return groups.map(([value, hosts]) => ({
    label,
    value: `${hosts.length} x ${value}${detail?.(hosts) ?? ''}${groups.length > 1 ? ` (${[...new Set(hosts)].join(', ')})` : ''}`,
  }))
}

/**
 * ClusterConfiguration lists the machines the exporters scraped, beside the
 * System block that describes the host benchmarkoor itself ran on.
 */
export function ClusterConfiguration({ nodeMetrics, deviceMetrics }: ClusterConfigurationProps) {
  const items = useMemo(
    () => [
      ...(nodeMetrics ? clusterItems(nodeFacts(nodeMetrics), 'Nodes') : []),
      ...(deviceMetrics ? clusterItems(gpuFacts(deviceMetrics), 'GPUs', perNode) : []),
    ],
    [nodeMetrics, deviceMetrics],
  )

  if (items.length === 0) {
    return null
  }

  return (
    <div className="mt-6 border-t border-gray-200 pt-6 dark:border-gray-700">
      <h4 className="mb-3 text-sm/6 font-medium text-gray-900 dark:text-gray-100">Cluster</h4>
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((item) => (
          <ClusterItem key={`${item.label} ${item.value}`} {...item} />
        ))}
      </dl>
    </div>
  )
}
