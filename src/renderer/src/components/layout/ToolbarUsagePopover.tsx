import { useEffect, useState } from 'react'
import { ArrowPathIcon, ChartBarIcon, XMarkIcon } from '@heroicons/react/24/outline'
import { Popover, PopoverTrigger, PopoverContent } from '../ui/popover'
import { UsageBar, UsageBarsSkeleton, barColor } from '../usage/usage-bits'
import { useUsageStore } from '../../store/usage-store'
import { useSessionStore } from '../../store/session-store'

/** How often the popover re-reads usage while it stays open. */
const POLL_MS = 60_000

/**
 * Toolbar readout of Claude Code rate-limit usage. Shows the same bars as
 * Settings > Usage, rendered from the same components and the same cached
 * store, so opening this costs at most one Keychain read per minute. The
 * trigger icon picks up the urgency color of the tightest window once usage
 * has been loaded.
 */
export function ToolbarUsagePopover(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const status = useUsageStore((s) => s.status)
  const data = useUsageStore((s) => s.data)
  const error = useUsageStore((s) => s.error)
  const refresh = useUsageStore((s) => s.refresh)
  const openSettings = useSessionStore((s) => s.openSettings)

  // Fetching only on open keeps Clave away from the Keychain until the user
  // asks for a number; the TTL then absorbs repeat opens.
  useEffect(() => {
    if (!open) return
    void refresh()
    const id = setInterval(() => void refresh(true), POLL_MS)
    return () => clearInterval(id)
  }, [open, refresh])

  const windows = data?.windows ?? []
  // Tightest window drives both the tint and the tooltip.
  const tightest = windows.reduce<(typeof windows)[number] | null>(
    (peak, w) => (peak === null || w.usedPercentage > peak.usedPercentage ? w : peak),
    null
  )
  const peakPct = tightest ? Math.round(tightest.usedPercentage) : null
  const loading = status === 'loading'

  const handleOpenSettings = (): void => {
    setOpen(false)
    openSettings('usage')
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className="btn-icon btn-icon-sm flex-shrink-0"
          title={
            tightest && peakPct !== null
              ? `${tightest.label}: ${peakPct}% used`
              : 'Claude Code usage'
          }
          style={
            tightest && tightest.usedPercentage >= 70
              ? { color: barColor(tightest.usedPercentage) }
              : undefined
          }
        >
          <ChartBarIcon className="w-4 h-4" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        animated
        open={open}
        side="bottom"
        align="end"
        sideOffset={8}
        className="w-[300px]"
      >
        <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-subtle">
          <ChartBarIcon className="w-3.5 h-3.5 text-text-tertiary" />
          <span className="text-xs text-text-secondary flex-1">Claude Code usage</span>
          <button
            onClick={() => void refresh(true)}
            disabled={loading}
            className="btn-icon btn-icon-xs disabled:opacity-50"
            title="Refresh"
          >
            <ArrowPathIcon className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button onClick={() => setOpen(false)} className="btn-icon btn-icon-xs" title="Close">
            <XMarkIcon className="w-3.5 h-3.5" />
          </button>
        </div>

        <div className="px-3 py-3">
          {status === 'error' ? (
            <div className="flex flex-col items-start gap-2 py-1">
              <span className="text-xs text-text-tertiary leading-snug">{error}</span>
              <button
                onClick={() => void refresh(true)}
                className="text-xs text-accent transition-colors hover:text-accent-hover"
              >
                Retry
              </button>
            </div>
          ) : windows.length > 0 ? (
            <div className="space-y-4">
              {windows.map((w) => (
                <UsageBar key={w.key} window={w} />
              ))}
            </div>
          ) : status === 'ready' ? (
            <span className="text-xs text-text-tertiary">No usage limits to show yet.</span>
          ) : (
            <UsageBarsSkeleton />
          )}
        </div>

        <button
          onClick={handleOpenSettings}
          className="settings-row-action border-t border-border-subtle"
        >
          Open usage settings
        </button>
      </PopoverContent>
    </Popover>
  )
}
