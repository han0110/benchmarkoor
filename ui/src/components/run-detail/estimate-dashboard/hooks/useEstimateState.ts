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
  ecSortBy?: EstimateSortField
  ecSortOrder?: SortOrder
  ecShare?: boolean
  ecSigned?: boolean
  ecFit?: FitModelKey
}

const DEFAULT_STATE: EstimateState = {
  activeTab: 'overview',
  categories: [], // Empty means all
  // The largest errors lead, so the tests the estimate misses most read first.
  sortBy: 'error',
  sortOrder: 'desc',
  costShare: false,
  signedError: false,
  fitModel: FIT_MODELS[0].value,
}

/** The search parameter of each field of the state. A field at its default leaves the URL. */
const PARAMS: { [K in keyof EstimateState]-?: keyof EstimateSearch } = {
  activeTab: 'ecTab',
  categories: 'ecCategories',
  minThroughput: 'ecMin',
  maxThroughput: 'ecMax',
  sortBy: 'ecSortBy',
  sortOrder: 'ecSortOrder',
  costShare: 'ecShare',
  signedError: 'ecSigned',
  fitModel: 'ecFit',
}

export function useEstimateState(runId: string) {
  const navigate = useNavigate()
  const search = useSearch({ from: '/runs/$runId' }) as EstimateSearch & Record<string, unknown>

  const state = useMemo<EstimateState>(
    () => ({
      activeTab: search.ecTab ?? DEFAULT_STATE.activeTab,
      categories: parseCategories(search.ecCategories),
      minThroughput: search.ecMin,
      maxThroughput: search.ecMax,
      sortBy: search.ecSortBy ?? DEFAULT_STATE.sortBy,
      sortOrder: search.ecSortOrder ?? DEFAULT_STATE.sortOrder,
      costShare: search.ecShare ?? DEFAULT_STATE.costShare,
      signedError: search.ecSigned ?? DEFAULT_STATE.signedError,
      fitModel: search.ecFit ?? DEFAULT_STATE.fitModel,
    }),
    [search],
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

      navigate({
        to: '/runs/$runId',
        params: { runId },
        search: nextSearch,
      })
    },
    [navigate, runId, search, state],
  )

  return { state, updateState }
}
