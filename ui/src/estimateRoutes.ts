import { createRoute, type AnyRootRoute } from '@tanstack/react-router'
import { EstimatesPage } from '@/pages/EstimatesPage'
import { EstimateDetailPage } from '@/pages/EstimateDetailPage'
import { EstimateComparePage } from '@/pages/EstimateComparePage'

/** The routes of the Estimates area. The static compare segment outranks the estimate id. */
export function estimateRoutes(rootRoute: AnyRootRoute) {
  return [
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/estimates',
      component: EstimatesPage,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/estimates/$estimateId',
      component: EstimateDetailPage,
    }),
    createRoute({
      getParentRoute: () => rootRoute,
      path: '/estimates/compare',
      component: EstimateComparePage,
    }),
  ]
}
