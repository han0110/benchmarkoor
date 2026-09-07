import { useMemo } from 'react'
import { formatCost } from '@/utils/estimate'
import { CategorySummary, PercentileCards } from '../../block-logs-dashboard/components/DistributionTab'
import { summariseByCategory } from '../../block-logs-dashboard/utils/statistics'
import type { EstimateRow } from '../types'

interface DistributionTabProps {
  rows: EstimateRow[]
}

/** Where the cost of the tests falls, over all of them and per category. */
export function DistributionTab({ rows }: DistributionTabProps) {
  const sorted = useMemo(() => rows.map((row) => row.total).sort((a, b) => a - b), [rows])
  const groups = useMemo(() => summariseByCategory(rows, (row) => row.total), [rows])

  if (rows.length === 0) {
    return (
      <div className="py-8 text-center text-sm text-gray-500 dark:text-gray-400">
        No data available for the current filters.
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PercentileCards title="Estimated Cost Percentiles" sorted={sorted} format={formatCost} />

      <CategorySummary title="Category Summary (Estimated Cost)" groups={groups} format={formatCost} />
    </div>
  )
}
