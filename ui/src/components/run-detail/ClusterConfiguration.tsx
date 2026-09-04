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
  label: string
  value: string
}

function ClusterItem({ label, value }: DeviceFacts) {
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
 * the charts does.
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
      label: host(metrics.devices[index]),
      value: line([cores === null ? null : `${cores} processors`, ramTotalGiB === null ? null : `${ramTotalGiB.toFixed(1)} GiB RAM`]),
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
      label: `${host(device)} gpu${device.labels.gpu}`,
      value: line([
        device.labels.modelName ?? null,
        frameBufferGiB === null ? null : `${frameBufferGiB.toFixed(1)} GiB frame buffer`,
        powerLimit === null ? null : `${powerLimit.toFixed(0)} W cap`,
      ]),
    }
  })
}

/**
 * ClusterConfiguration lists the machines the exporters scraped, beside the
 * System block that describes the host benchmarkoor itself ran on.
 */
export function ClusterConfiguration({ nodeMetrics, deviceMetrics }: ClusterConfigurationProps) {
  const devices = useMemo(
    () => [...(nodeMetrics ? nodeFacts(nodeMetrics) : []), ...(deviceMetrics ? gpuFacts(deviceMetrics) : [])].filter((device) => device.value !== ''),
    [nodeMetrics, deviceMetrics],
  )

  if (!nodeMetrics && !deviceMetrics) {
    return null
  }

  return (
    <div className="mt-6 border-t border-gray-200 pt-6 dark:border-gray-700">
      <h4 className="mb-3 text-sm/6 font-medium text-gray-900 dark:text-gray-100">Cluster</h4>
      <dl className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {nodeMetrics && <ClusterItem label="Nodes" value={`${nodeMetrics.devices.length}`} />}
        {deviceMetrics && <ClusterItem label="GPUs" value={`${deviceMetrics.devices.length}`} />}
        {devices.map((device) => (
          <ClusterItem key={device.label} {...device} />
        ))}
      </dl>
    </div>
  )
}
