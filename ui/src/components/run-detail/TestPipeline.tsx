import { useMemo, useState } from 'react'
import clsx from 'clsx'
import type { TestPipelineView } from '@/api/hooks/useTestPipeline'
import { NODE_HUES } from '@/utils/testMetrics'
import { PipelineGantt } from './PipelineGantt'

interface TestPipelineProps {
  pipeline: TestPipelineView
}

/** Lightness of every next cycle of the hues, so sixteen workers stay apart. */
const WORKER_LIGHTNESS = [50, 36, 64, 28]

/**
 * TestPipeline is the proving pipeline tab of the test modal. The worker legend
 * isolates one worker on a click and toggles one on a modifier click, and the
 * kind legend names the shades of the bars.
 */
export function TestPipeline({ pipeline: { model, breakdown } }: TestPipelineProps) {
  const workers = model.workers
  const [selected, setSelected] = useState<string[] | null>(null)
  const shown = selected ?? workers
  const items = useMemo(() => model.items.filter((item) => shown.includes(item.workerName)), [model, shown])
  const workerColors = useMemo(
    () =>
      Object.fromEntries(
        workers.map((worker, index) => [
          worker,
          `hsl(${NODE_HUES[index % NODE_HUES.length]}, 70%, ${WORKER_LIGHTNESS[Math.floor(index / NODE_HUES.length) % WORKER_LIGHTNESS.length]}%)`,
        ]),
      ),
    [workers],
  )

  const toggleWorker = (worker: string, additive: boolean) =>
    setSelected((current) => {
      const active = current ?? workers
      if (!additive) return active.length === 1 && active[0] === worker ? null : [worker]
      // Toggling the last worker off would empty the chart, so it restores all.
      const next = workers.filter((candidate) => (candidate === worker ? !active.includes(worker) : active.includes(candidate)))

      return next.length === 0 ? null : next
    })

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-3">
        {model.kindsUsed.map((kind) => (
          <span key={kind.label} className="flex items-center gap-1.5 text-xs/5 text-gray-500 dark:text-gray-400">
            <span className="size-2 rounded-full" style={{ backgroundColor: kind.color }} />
            {kind.label}
          </span>
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        <span className="text-xs/5 text-gray-500 dark:text-gray-400">Worker</span>
        {workers.map((worker) => (
          <button
            key={worker}
            type="button"
            title="Click to isolate, cmd, ctrl or shift click to toggle"
            onClick={(event) => toggleWorker(worker, event.metaKey || event.ctrlKey || event.shiftKey)}
            className={clsx(
              'flex items-center gap-1.5 rounded-xs border border-gray-200 px-1.5 py-0.5 text-xs font-medium text-gray-700 transition-opacity dark:border-gray-600 dark:text-gray-200',
              !shown.includes(worker) && 'opacity-40',
            )}
          >
            <span className="size-2 rounded-full" style={{ backgroundColor: workerColors[worker] }} />
            {worker}
          </button>
        ))}
      </div>

      <PipelineGantt items={items} endSec={model.endSec} breakdown={breakdown} workerColors={workerColors} />
    </div>
  )
}
