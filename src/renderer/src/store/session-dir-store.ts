import { create } from 'zustand'

/**
 * Where a new session starts.
 *
 * `lastUsed` opens straight into the most recent directory, so Cmd+N is a
 * single keystroke. `alwaysAsk` restores the folder picker on every launch.
 * Either way the picker stays one Option key (or one menu item) away.
 */
export type NewSessionDirMode = 'lastUsed' | 'alwaysAsk'

/** Persisted through `preferencesGet`/`preferencesSet` (clave-preferences.json). */
const RECENT_DIRS_KEY = 'recentSessionDirs'
const DIR_MODE_KEY = 'newSessionDirMode'

/** Cap on the stored MRU. The dropdown shows the first few of these. */
export const MAX_RECENT_SESSION_DIRS = 8

interface SessionDirState {
  /** Most-recent-first list of directories new sessions were opened in. */
  recentDirs: string[]
  mode: NewSessionDirMode
  loaded: boolean
  setMode: (mode: NewSessionDirMode) => void
}

export const useSessionDirStore = create<SessionDirState>((set) => ({
  recentDirs: [],
  mode: 'lastUsed',
  loaded: false,
  setMode: (mode) => {
    window.electronAPI?.preferencesSet(DIR_MODE_KEY, mode).catch(() => {})
    set({ mode })
  }
}))

function persistRecentDirs(dirs: string[]): void {
  window.electronAPI?.preferencesSet(RECENT_DIRS_KEY, dirs).catch(() => {})
}

let loadPromise: Promise<void> | null = null

async function load(): Promise<void> {
  try {
    const rawDirs = (await window.electronAPI?.preferencesGet(RECENT_DIRS_KEY)) as unknown
    const rawMode = (await window.electronAPI?.preferencesGet(DIR_MODE_KEY)) as unknown
    const recentDirs = Array.isArray(rawDirs)
      ? rawDirs.filter((d): d is string => typeof d === 'string' && d.length > 0).slice(0, MAX_RECENT_SESSION_DIRS)
      : []
    const mode: NewSessionDirMode = rawMode === 'alwaysAsk' ? 'alwaysAsk' : 'lastUsed'
    useSessionDirStore.setState({ recentDirs, mode, loaded: true })
  } catch {
    useSessionDirStore.setState({ loaded: true })
  }
}

/** Read the persisted preferences once per process. Safe to call from anywhere. */
export function ensureSessionDirPrefsLoaded(): Promise<void> {
  if (!loadPromise) loadPromise = load()
  return loadPromise
}

/** Record a directory a session just opened in, at the head of the MRU. */
export function pushRecentSessionDir(dir: string): void {
  if (!dir) return
  const current = useSessionDirStore.getState().recentDirs
  const next = [dir, ...current.filter((d) => d !== dir)].slice(0, MAX_RECENT_SESSION_DIRS)
  if (next.length === current.length && next.every((d, i) => d === current[i])) return
  useSessionDirStore.setState({ recentDirs: next })
  persistRecentDirs(next)
}

/**
 * The MRU with directories that no longer exist removed. A folder that was
 * renamed, moved, or deleted between runs would otherwise spawn a session into
 * nothing, so the check happens on every read and the pruned list is persisted.
 * A failed check keeps the entry: a transient error should not lose history.
 */
export async function getRecentSessionDirs(): Promise<string[]> {
  await ensureSessionDirPrefsLoaded()
  const dirs = useSessionDirStore.getState().recentDirs
  if (dirs.length === 0) return dirs

  const exists = await Promise.all(
    dirs.map((dir) =>
      window.electronAPI?.claveFileExists(dir).catch(() => true) ?? Promise.resolve(true)
    )
  )
  const alive = dirs.filter((_, i) => exists[i])
  if (alive.length !== dirs.length) {
    useSessionDirStore.setState({ recentDirs: alive })
    persistRecentDirs(alive)
  }
  return alive
}

/** Load + prune, for surfaces that render the list (menus, settings). */
export function refreshRecentSessionDirs(): void {
  void getRecentSessionDirs()
}

/**
 * The directory a new session should open in.
 *
 * Returns null only when the user dismisses the picker. `forcePicker` is the
 * Option modifier and the "Other folder..." menu item: it always asks, whatever
 * the saved preference says.
 */
export async function resolveNewSessionDir(opts?: { forcePicker?: boolean }): Promise<string | null> {
  const recent = await getRecentSessionDirs()
  const lastUsed = recent[0]
  const { mode } = useSessionDirStore.getState()
  if (!opts?.forcePicker && mode === 'lastUsed' && lastUsed) return lastUsed
  return (await window.electronAPI.openFolderDialog(lastUsed)) ?? null
}
