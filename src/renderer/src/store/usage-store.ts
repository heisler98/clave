import { create } from 'zustand'
import type { UsageLimits } from '../../../preload/index.d'

/**
 * Shared cache for Claude Code rate-limit usage. Every fetch reads the OAuth
 * token out of the macOS Keychain and hits the network, so the settings page
 * and the toolbar popover read through this one store instead of fetching
 * independently. A short TTL collapses repeat opens into a single request.
 */

const TTL_MS = 60_000

export type UsageStatus = 'idle' | 'loading' | 'ready' | 'error'

interface UsageState {
  status: UsageStatus
  data: UsageLimits | null
  error: string | null
  /** When the last attempt settled (success or failure), for TTL accounting. */
  fetchedAt: number | null
  /** Fetch unless a fresh result is already cached. `force` skips the TTL. */
  refresh: (force?: boolean) => Promise<void>
}

// Module-level so concurrent callers (popover opening while settings mounts)
// share one request rather than racing two Keychain reads.
let inflight: Promise<void> | null = null

export const useUsageStore = create<UsageState>((set, get) => ({
  status: 'idle',
  data: null,
  error: null,
  fetchedAt: null,

  refresh: async (force = false) => {
    if (inflight) return inflight

    const { fetchedAt } = get()
    if (!force && fetchedAt !== null && Date.now() - fetchedAt < TTL_MS) return

    const api = window.electronAPI
    if (!api?.getUsageLimits) {
      set({
        status: 'error',
        error: 'Usage is only available in the desktop app.',
        data: null,
        fetchedAt: Date.now()
      })
      return
    }

    set({ status: 'loading', error: null })

    inflight = (async () => {
      try {
        const result = await api.getUsageLimits()
        if ('error' in result) {
          set({ status: 'error', error: result.error, data: null, fetchedAt: Date.now() })
          return
        }
        set({
          status: 'ready',
          data: result,
          error: null,
          fetchedAt: result.fetchedAt || Date.now()
        })
      } catch {
        set({ status: 'error', error: 'Failed to load usage.', data: null, fetchedAt: Date.now() })
      } finally {
        inflight = null
      }
    })()

    return inflight
  }
}))
