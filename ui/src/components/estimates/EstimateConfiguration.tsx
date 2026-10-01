import { useState } from 'react'
import clsx from 'clsx'
import { ChevronDown, Settings } from 'lucide-react'
import type { RunEstimate } from '@/api/types'
import { CopyButton, InfoItem } from '@/components/run-detail/RunConfiguration'
import { imageTag } from './estimateEntries'

/** The guest program and the ere-server of an estimate, in the markup of RunConfiguration. */
export function EstimateConfiguration({ estimate }: { estimate: RunEstimate }) {
  const [expanded, setExpanded] = useState(false)
  const labels = estimate.metadata.labels

  return (
    <div className="overflow-hidden rounded-sm bg-white shadow-xs dark:bg-gray-800">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex w-full cursor-pointer items-center justify-between gap-3 border-b border-gray-200 px-4 py-3 text-left hover:bg-gray-50 dark:border-gray-700 dark:hover:bg-gray-700/50"
      >
        <h3 className="flex shrink-0 items-center gap-2 text-sm/6 font-medium text-gray-900 dark:text-gray-100">
          <Settings className="size-4 text-gray-400 dark:text-gray-500" />
          Configuration
        </h3>
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex min-w-0 flex-wrap items-center gap-1.5 text-xs/5">
            <span className="text-gray-400 dark:text-gray-500">Image:</span>
            <span className="text-gray-600 dark:text-gray-300">{imageTag(estimate.image)}</span>
            {labels?.zkvm_version && (
              <>
                <span className="text-gray-300 dark:text-gray-600">·</span>
                <span className="text-gray-400 dark:text-gray-500">Version:</span>
                <span className="text-gray-600 dark:text-gray-300">{labels.zkvm_version}</span>
              </>
            )}
          </span>
          <ChevronDown className={clsx('size-5 shrink-0 text-gray-500 transition-transform', expanded && 'rotate-180')} />
        </div>
      </button>
      {expanded && (
        <div className="grid grid-cols-1 gap-6 p-4 lg:grid-cols-2">
          <div>
            <h4 className="mb-3 text-sm/6 font-medium text-gray-900 dark:text-gray-100">Instance</h4>
            <dl className="flex flex-col gap-4">
              <InfoItem label="Stateless Validator" value={labels?.stateless_validator ?? '-'} />
              <InfoItem label="zkVM" value={estimate.zkvm} />
              <InfoItem label="zkVM Version" value={labels?.zkvm_version ?? '-'} />
              <div>
                <dt className="text-xs/5 font-medium text-gray-500 dark:text-gray-400">ELF</dt>
                <dd className="mt-1 flex items-center gap-2 text-sm/6">
                  <a
                    href={estimate.elf_url}
                    target="_blank"
                    rel="noreferrer"
                    className="text-blue-600 hover:text-blue-800 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
                  >
                    {estimate.elf_url.split('/').pop()}
                  </a>
                  <CopyButton text={estimate.elf_url} />
                </dd>
              </div>
              <div>
                <dt className="text-xs/5 font-medium text-gray-500 dark:text-gray-400">ELF SHA256</dt>
                <dd className="mt-1 flex items-start gap-2">
                  <span className="break-all font-mono text-sm/6 text-gray-900 dark:text-gray-100">
                    {estimate.elf_sha256}
                  </span>
                  <CopyButton text={estimate.elf_sha256} />
                </dd>
              </div>
              <InfoItem label="Image" value={estimate.image} />
              {estimate.image_sha256 && (
                <div>
                  <dt className="text-xs/5 font-medium text-gray-500 dark:text-gray-400">Image SHA256</dt>
                  <dd className="mt-1 flex items-center gap-2">
                    <span className="font-mono text-sm/6 text-gray-900 dark:text-gray-100">
                      {estimate.image_sha256.length > 20
                        ? `${estimate.image_sha256.slice(0, 20)}...`
                        : estimate.image_sha256}
                    </span>
                    <CopyButton text={estimate.image_sha256} />
                  </dd>
                </div>
              )}
              {estimate.command && estimate.command.length > 0 && (
                <div>
                  <dt className="flex items-center gap-2 text-xs/5 font-medium text-gray-500 dark:text-gray-400">
                    Command
                    <CopyButton text={estimate.command.join(' ')} />
                  </dt>
                  <dd className="mt-1 overflow-x-auto rounded-sm bg-gray-100 p-2 font-mono text-xs/5 text-gray-900 dark:bg-gray-900 dark:text-gray-100">
                    {estimate.command.join(' ')}
                  </dd>
                </div>
              )}
            </dl>
          </div>
        </div>
      )}
    </div>
  )
}
