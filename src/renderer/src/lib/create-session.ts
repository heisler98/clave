import { useSessionStore } from '../store/session-store'
import {
  getClaudeProfile,
  useClaudeProfileStore,
  claudeProfileSpawnFields
} from '../store/claude-profile-store'
import { pushRecentSessionDir, resolveNewSessionDir } from '../store/session-dir-store'

/**
 * Everything a local new session needs besides its directory.
 *
 * The single description of "spawn a session and put it in the sidebar" for
 * every entry point: the keyboard shortcuts, the sidebar dropdown, and the
 * empty-state button. Keeping one copy is what stops the three from drifting.
 */
export interface NewSessionOptions {
  claudeMode: boolean
  dangerousMode: boolean
  antigravityMode?: boolean
  codexMode?: boolean
  claudeAgentsMode?: boolean
  /** Claude account/profile. Omitted = the selected default profile. */
  claudeProfileId?: string
  /** Run this session inside tmux. Omitted follows the global setting.
   *
   *  Set false for a session that needs macOS to attribute its work to Clave.
   *  tmux panes hang off a detached server that outlives the app, so anything
   *  under one is several generations removed from Clave and is attributed
   *  elsewhere. Microphone access for voice input is the case that hits. */
  tmuxMode?: boolean
}

/** Where the session should land. */
export interface CreateSessionContext {
  cwd: string
}

/** Options implied by the app's current mode toggles, for entry points that
 *  carry no provider choice of their own (the empty-state button). */
export function defaultNewSessionOptions(): NewSessionOptions {
  const state = useSessionStore.getState()
  return {
    claudeMode: state.claudeMode,
    dangerousMode: state.dangerousMode,
    antigravityMode: state.antigravityMode,
    codexMode: state.codexMode,
    claudeAgentsMode: state.claudeAgentsMode
  }
}

/**
 * Spawn a session in `cwd` and add it to the sidebar. Returns the new session
 * id, or null when the spawn failed.
 */
export async function createSession(
  options: NewSessionOptions,
  { cwd }: CreateSessionContext
): Promise<string | null> {
  const {
    claudeMode,
    dangerousMode,
    antigravityMode,
    codexMode,
    claudeAgentsMode,
    claudeProfileId,
    tmuxMode
  } = options

  const otherProvider = !!(antigravityMode || codexMode || claudeAgentsMode)
  const effectiveClaudeMode = otherProvider ? false : claudeMode
  // Claude account/profile: applies only to Claude Code + Claude Agents
  // sessions, and never to plain terminals, Antigravity, or Codex. The default
  // profile contributes no configDir (passthrough).
  const isClaudeSession = effectiveClaudeMode || !!claudeAgentsMode
  const profile = isClaudeSession
    ? getClaudeProfile(claudeProfileId ?? useClaudeProfileStore.getState().selectedProfileId)
    : null
  const profileFields = profile ? claudeProfileSpawnFields(profile) : {}

  try {
    const sessionInfo = await window.electronAPI.spawnSession(cwd, {
      claudeMode: effectiveClaudeMode,
      antigravityMode,
      codexMode,
      claudeAgentsMode,
      dangerousMode,
      // Undefined leaves the choice to the global setting, which the spawn
      // handler resolves.
      ...(tmuxMode === undefined ? {} : { tmuxMode }),
      ...profileFields
    })
    useSessionStore.getState().addSession({
      id: sessionInfo.id,
      cwd: sessionInfo.cwd,
      folderName: sessionInfo.folderName,
      name: sessionInfo.folderName,
      nameSource: 'auto',
      alive: sessionInfo.alive,
      activityStatus: 'idle',
      promptWaiting: null,
      claudeMode: effectiveClaudeMode,
      antigravityMode: antigravityMode ?? false,
      codexMode: codexMode ?? false,
      claudeAgentsMode: claudeAgentsMode ?? false,
      dangerousMode,
      claudeSessionId: sessionInfo.claudeSessionId,
      claudeProfileId: profile?.id,
      claudeProfileLabel: profile?.label,
      claudeConfigDir: profile?.configDir || undefined,
      sessionType: 'local',
      detectedUrl: null,
      serverStatus: null,
      serverCommand: null,
      hasUnseenActivity: false,
      planFilePath: null
    })
    // Remember where this landed, so the next launch can skip the picker.
    pushRecentSessionDir(sessionInfo.cwd)
    return sessionInfo.id
  } catch (err) {
    console.error('Failed to create session:', err)
    return null
  }
}

/**
 * Resolve the directory (last used, or the picker) and spawn there.
 *
 * `cwd` launches straight into a directory the caller already chose (a Recent
 * entry). `forcePicker` always opens the folder dialog, whatever the saved
 * preference says. Returns null when the picker was dismissed.
 */
export async function launchNewSession(
  options: NewSessionOptions,
  ctx?: { cwd?: string; forcePicker?: boolean }
): Promise<string | null> {
  const cwd = ctx?.cwd ?? (await resolveNewSessionDir({ forcePicker: ctx?.forcePicker }))
  if (!cwd) return null
  return createSession(options, { cwd })
}
