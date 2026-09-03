import clsx from 'clsx'
import { getBaseClient, getClientColors, getClientDisplayName, getClientLogoUrl } from '@/utils/client-colors'

interface ClientBadgeProps {
  client: string
  metadata?: Record<string, string>
  className?: string
  hideLabel?: boolean
}

function capitalizeFirst(str: string): string {
  if (!str) return str
  return str.charAt(0).toUpperCase() + str.slice(1)
}

export function ClientBadge({ client, metadata, className, hideLabel = false }: ClientBadgeProps) {
  const base = getBaseClient(client)
  const colors = getClientColors(client)
  const logoPath = getClientLogoUrl(base)
  const displayName = getClientDisplayName(client, metadata)
  // Names derived from labels keep their casing, so ethrex-zisk does not
  // render as Ethrex-zisk.
  const label = displayName === client ? capitalizeFirst(client) : displayName

  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-xs text-xs/5 font-medium',
        hideLabel ? 'p-0.5' : 'w-28 gap-1.5 px-2.5 py-0.5',
        colors.bg,
        colors.text,
        colors.darkBg,
        colors.darkText,
        className,
      )}
    >
      <img src={logoPath} alt={`${client} logo`} className="size-4 rounded-full object-cover" />
      {!hideLabel && (
        <span className="truncate" title={label}>
          {label}
        </span>
      )}
    </span>
  )
}
