import { useNavigate, useSearch } from '@tanstack/react-router'
import { useCallback, useMemo } from 'react'
import { FIT_MODELS, type FitModelKey } from '@/utils/estimate'
import { parseCategories } from '../../block-logs-dashboard/hooks/useDashboardState'
import type { SortOrder } from '../../block-logs-dashboard/types'
import type { EstimateSortField, EstimateState, EstimateTab } from '../types'

interface EstimateSearch {
  ecTab?: EstimateTab
  ecCategories?: string // Comma-separated list of categories
  ecMin?: number
  ecMax?: number
  ecCostMin?: number
  ecCostMax?: number
  ecSortBy?: EstimateSortField
  ecSortOrder?: SortOrder
  ecShare?: boolean
  ecSigned?: boolean
  ecFit?: FitModelKey
}

const DEFAULT_STATE: EstimateState = {
  activeTab: 'overview',
  categories: [], // Empty means all
  // The most expensive tests lead.
  sortBy: 'cost',
  sortOrder: 'desc',
  costShare: true,
  signedError: false,
  fitModel: FIT_MODELS[0].value,
}

/** The search parameter of each field of the state. A field at its default leaves the URL. */
const PARAMS: { [K in keyof EstimateState]-?: keyof EstimateSearch } = {
  activeTab: 'ecTab',
  categories: 'ecCategories',
  minThroughput: 'ecMin',
  maxThroughput: 'ecMax',
  minCost: 'ecCostMin',
  maxCost: 'ecCostMax',
  sortBy: 'ecSortBy',
  sortOrder: 'ecSortOrder',
  costShare: 'ecShare',
  signedError: 'ecSigned',
  fitModel: 'ecFit',
}

export function useEstimateState() {
  const navigate = useNavigate()
  const search = useSearch({ strict: false }) as EstimateSearch & Record<string, unknown>

  const categories = useMemo(() => parseCategories(search.ecCategories), [search.ecCategories])
  const state = useMemo<EstimateState>(
    () => ({
      activeTab: search.ecTab ?? DEFAULT_STATE.activeTab,
      categories,
      minThroughput: search.ecMin,
      maxThroughput: search.ecMax,
      minCost: search.ecCostMin,
      maxCost: search.ecCostMax,
      sortBy: search.ecSortBy ?? DEFAULT_STATE.sortBy,
      sortOrder: search.ecSortOrder ?? DEFAULT_STATE.sortOrder,
      costShare: search.ecShare ?? DEFAULT_STATE.costShare,
      signedError: search.ecSigned ?? DEFAULT_STATE.signedError,
      fitModel: search.ecFit ?? DEFAULT_STATE.fitModel,
    }),
    [search, categories],
  )

  const updateState = useCallback(
    (updates: Partial<EstimateState>) => {
      const next = { ...state, ...updates }
      const nextSearch: Record<string, unknown> = { ...search }

      for (const key of Object.keys(PARAMS) as (keyof EstimateState)[]) {
        const value = key === 'categories' ? (next.categories.length > 0 ? next.categories.join(',') : undefined) : next[key]
        if (value === undefined || value === DEFAULT_STATE[key]) {
          delete nextSearch[PARAMS[key]]
        } else {
          nextSearch[PARAMS[key]] = value
        }
      }

      navigate({ to: '.', search: nextSearch })
    },
    [navigate, search, state],
  )

  return { state, updateState }
}
