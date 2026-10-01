import { useMemo } from 'react'
import clsx from 'clsx'
import { AlertTriangle } from 'lucide-react'
import type { SuiteTest } from '@/api/types'
import { TestName } from '@/components/shared/TestName'
import { suiteOrder } from '@/utils/estimate'

interface FailureTableProps {
  /** The failed tests the filters keep, in suite order. */
  testNames: string[]
  /** The guest error of each failed test, keyed by test name. */
  failures: Record<string, string>
  /** Suite tests in canonical run order, which give the number of each test. */
  suiteTests?: SuiteTest[]
  /** The page search, whose terms the chips of the names show as active. */
  searchQuery?: string
  onChipClick?: (term: string) => void
  onTestClick?: (testName: string) => void
}

/** The kept tests that failed, with the guest error of each. */
export function FailureTable({ testNames, failures, suiteTests, searchQuery, onChipClick, onTestClick }: FailureTableProps) {
  const { positions } = useMemo(() => suiteOrder(suiteTests), [suiteTests])

  return (
    <div className="flex flex-col gap-4">
      <h2 className="flex items-center gap-2 text-lg/7 font-semibold text-gray-900 dark:text-gray-100">
        <AlertTriangle className="size-5 text-gray-400 dark:text-gray-500" />
        Failures ({testNames.length})
      </h2>

      <div className="max-h-[70vh] overflow-auto rounded-sm bg-white shadow-xs dark:bg-gray-800">
        <table className="min-w-full divide-y divide-gray-200 dark:divide-gray-700">
          <thead className="sticky top-0 z-10 bg-gray-50 dark:bg-gray-900">
            <tr>
              <th scope="col" className="w-12 px-4 py-3 text-left text-xs/5 font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                #
              </th>
              <th scope="col" className="px-4 py-3 text-left text-xs/5 font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                Test
              </th>
              <th scope="col" className="px-4 py-3 text-left text-xs/5 font-medium uppercase tracking-wider text-gray-500 dark:text-gray-400">
                Error
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {testNames.map((testName) => (
              <tr
                key={testName}
                onClick={() => onTestClick?.(testName)}
                className={clsx('transition-colors hover:bg-gray-50 dark:hover:bg-gray-700/50', onTestClick && 'cursor-pointer')}
              >
                <td className="whitespace-nowrap px-4 py-3 text-sm/6 font-medium text-gray-500 dark:text-gray-400">{positions.get(testName) ?? '-'}</td>
                <td className="max-w-md px-4 py-3">
                  <TestName name={testName} onChipClick={onChipClick} activeQuery={searchQuery} className="text-sm/6 font-medium text-gray-900 dark:text-gray-100" />
                </td>
                <td className="px-4 py-3 font-mono text-xs/5 text-red-600 dark:text-red-400">{failures[testName]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
