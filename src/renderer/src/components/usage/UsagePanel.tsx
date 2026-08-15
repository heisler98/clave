import { useEffect, useState, type ReactElement } from 'react'
import { ArrowPathIcon } from '@heroicons/react/24/outline'
import { ClaudeLogo, CodexLogo, AntigravityLogo } from '../icons/cli-logos'
import { UsageBar, UsageBarsSkeleton } from './usage-bits'
import { useUsageStore } from '../../store/usage-store'

type Tool = 'claude' | 'codex' | 'antigravity'

const TOOLS: { key: Tool; label: string; Logo: (p: { className?: string }) => ReactElement }[] = [
  { key: 'claude', label: 'Claude Code', Logo: ClaudeLogo },
  { key: 'codex', label: 'Codex', Logo: CodexLogo },
  { key: 'antigravity', label: 'Antigravity', Logo: AntigravityLogo }
]

function ToolToggle({
  tool,
  onChange
}: {
  tool: Tool
  onChange: (t: Tool) => void
}): React.JSX.Element {
  return (
    <div className="inline-flex w-full rounded-lg bg-surface-100 p-0.5">
      {TOOLS.map(({ key, label, Logo }) => {
        const active = key === tool
        return (
          <button
            key={key}
            onClick={() => onChange(key)}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-colors ${
              active
                ? 'bg-surface-200 text-text-primary'
                : 'text-text-tertiary hover:text-text-primary'
            }`}
          >
            <Logo className="w-3.5 h-3.5 flex-shrink-0" />
            {label}
          </button>
        )
      })}
    </div>
  )
}

function ClaudeUsage(): React.JSX.Element {
  const status = useUsageStore((s) => s.status)
  const data = useUsageStore((s) => s.data)
  const error = useUsageStore((s) => s.error)
  const refresh = useUsageStore((s) => s.refresh)

  // Lazy: this only mounts while the Claude tab is selected, so it asks for a
  // read each time the tab is opened. The store's TTL turns a repeat open into
  // a no-op instead of another Keychain read.
  useEffect(() => {
    void refresh()
  }, [refresh])

  const loading = status === 'loading'
  const windows = data?.windows ?? []

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-end">
        <button
          onClick={() => void refresh(true)}
          disabled={loading}
          className="btn-icon btn-icon-xs disabled:opacity-50"
          title="Refresh"
        >
          <ArrowPathIcon className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {status === 'error' ? (
        <div className="flex flex-col items-start gap-3 py-4">
          <span className="text-sm text-text-tertiary">{error}</span>
          <button
            onClick={() => void refresh(true)}
            className="text-xs text-accent transition-colors hover:text-accent-hover"
          >
            Retry
          </button>
        </div>
      ) : windows.length > 0 ? (
        <div className="space-y-5">
          {windows.map((w) => (
            <UsageBar key={w.key} window={w} />
          ))}
        </div>
      ) : status === 'ready' ? (
        <span className="text-sm text-text-tertiary">No usage limits to show yet.</span>
      ) : (
        <UsageBarsSkeleton />
      )}
    </div>
  )
}

function ComingSoon({ label }: { label: string }): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-1.5 py-12 text-center">
      <span className="text-sm font-medium text-text-primary">
        {label} usage isn’t available yet
      </span>
      <span className="text-xs text-text-tertiary">
        We’re working on bringing usage limits to {label}.
      </span>
    </div>
  )
}

/** Usage limits content — embedded in the settings page's Usage section. */
export function UsagePanel(): React.JSX.Element {
  const [tool, setTool] = useState<Tool>('claude')

  return (
    <div className="space-y-4">
      <ToolToggle tool={tool} onChange={setTool} />
      <div className="settings-card">
        <div className="px-3.5 py-3">
          {tool === 'claude' && <ClaudeUsage />}
          {tool === 'codex' && <ComingSoon label="Codex" />}
          {tool === 'antigravity' && <ComingSoon label="Antigravity" />}
        </div>
      </div>
    </div>
  )
}
