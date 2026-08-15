import { useCallback, useState } from 'react'
import { defaultNewSessionOptions, launchNewSession } from '../../lib/create-session'

export function NewSessionButton() {
  const [loading, setLoading] = useState(false)

  // Starts in the last used folder; holding Option opens the folder picker.
  const handleNewSession = useCallback(async (forcePicker: boolean) => {
    setLoading(true)
    try {
      await launchNewSession(defaultNewSessionOptions(), { forcePicker })
    } finally {
      setLoading(false)
    }
  }, [])

  return (
    <button
      onClick={(e) => void handleNewSession(e.altKey)}
      disabled={loading}
      title="New session (hold Option to choose a folder)"
      className="w-full flex items-center justify-center gap-2 px-3 py-2 rounded-lg bg-surface-200 hover:bg-surface-300 text-text-secondary hover:text-text-primary transition-colors text-sm font-medium disabled:opacity-50"
    >
      <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M7 1v12M1 7h12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
      </svg>
      {loading ? 'Starting...' : 'New Session'}
    </button>
  )
}
