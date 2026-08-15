import type { CSSProperties } from 'react'
import type { UsageWindow } from '../../../../preload/index.d'

/**
 * Shared presentation for a usage window. Both surfaces that show limits (the
 * settings page and the toolbar popover) render from here so a bar looks and
 * reads the same wherever it appears.
 */

// Mirrors the statusline's fmt_dur: seconds → "3h12m" / "12m".
export function formatReset(resetsAt: number | null): string | null {
  if (resetsAt == null) return null
  const secs = Math.max(0, Math.round((resetsAt - Date.now()) / 1000))
  const h = Math.floor(secs / 3600)
  const m = Math.floor((secs % 3600) / 60)
  if (h > 0) return `resets in ${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `resets in ${m}m`
  return 'resets shortly'
}

// Fill color tracks urgency, so a near-full cap reads at a glance. Returns a
// CSS color value (theme token) that feeds the .meter-fill custom property.
export function barColor(pct: number): string {
  if (pct >= 90) return 'var(--color-destructive)'
  if (pct >= 70) return 'var(--color-status-waiting)'
  return 'var(--color-accent)'
}

export function UsageBar({ window: usageWindow }: { window: UsageWindow }): React.JSX.Element {
  const pct = Math.round(usageWindow.usedPercentage)
  const reset = formatReset(usageWindow.resetsAt)
  // A non-zero cap still shows a sliver of fill so the bar reads as "started".
  const width = Math.min(100, Math.max(usageWindow.usedPercentage, pct === 0 ? 0 : 2))
  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-sm font-medium text-text-primary">{usageWindow.label}</span>
        <span className="text-sm tabular-nums font-semibold text-text-primary">{pct}%</span>
      </div>
      <div
        className="meter"
        style={
          {
            '--meter-value': `${width}%`,
            '--meter-color': barColor(usageWindow.usedPercentage)
          } as CSSProperties
        }
      >
        <span className="meter-fill" />
      </div>
      {reset && <span className="text-xs text-text-tertiary">{reset}</span>}
    </div>
  )
}

/** Placeholder rows shown while the first fetch is in flight. */
export function UsageBarsSkeleton({ rows = 3 }: { rows?: number }): React.JSX.Element {
  return (
    <div className="space-y-5">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="space-y-1.5">
          <div className="h-4 w-40 animate-pulse rounded bg-surface-200" />
          <div className="h-2 w-full animate-pulse rounded-full bg-surface-200" />
        </div>
      ))}
    </div>
  )
}
