import { CommandLineIcon, FolderIcon, FolderOpenIcon } from '@heroicons/react/24/outline'
import { ClaudeLogo, AntigravityLogo, CodexLogo } from '../icons/cli-logos'
import { defaultNewSessionOptions } from '../../lib/create-session'
import { shortenPath } from '../../lib/utils'

/** Everything a "new session" entry carries: which agent, which account, and
 *  where it lands. Shared by the dropdown and the trigger's right-click menu. */
export interface NewSessionLaunchOptions {
  claudeMode: boolean
  antigravityMode: boolean
  codexMode: boolean
  claudeAgentsMode: boolean
  dangerousMode: boolean
  locationId?: string
  /** Chosen Claude account/profile (omitted = selected default). */
  claudeProfileId?: string
  /** Launch straight into this directory (a Recent entry). */
  cwd?: string
  /** Always open the folder picker (Option, or "Other folder..."). */
  forcePicker?: boolean
}

/** How many recent folders the menus list. */
export const RECENT_MENU_LIMIT = 5

export function dirBasename(dir: string): string {
  return dir.split('/').filter(Boolean).pop() || dir
}

export function dirParent(dir: string): string {
  const parts = dir.split('/').filter(Boolean)
  parts.pop()
  return shortenPath('/' + parts.join('/'))
}

/** Launch options for entries that carry no agent of their own (a Recent
 *  folder, "Other folder..."): whatever the app's mode toggles currently say. */
export function defaultLaunchOptions(): NewSessionLaunchOptions {
  const defaults = defaultNewSessionOptions()
  return {
    claudeMode: defaults.claudeMode,
    antigravityMode: defaults.antigravityMode ?? false,
    codexMode: defaults.codexMode ?? false,
    claudeAgentsMode: defaults.claudeAgentsMode ?? false,
    dangerousMode: defaults.dangerousMode
  }
}

export interface NewSessionMenuItem {
  label: string
  onClick: () => void
  shortcut?: string
  icon?: React.ReactNode
}

/**
 * The dropdown's menu, flattened for `ui/ContextMenu` (right-click on the
 * "New session" row). One builder keeps the two surfaces in step.
 */
export function buildNewSessionMenuItems(
  recentDirs: string[],
  launch: (options: NewSessionLaunchOptions) => void
): NewSessionMenuItem[] {
  const agent = (over: Partial<NewSessionLaunchOptions>): NewSessionLaunchOptions => ({
    claudeMode: false,
    antigravityMode: false,
    codexMode: false,
    claudeAgentsMode: false,
    dangerousMode: false,
    ...over
  })

  const items: NewSessionMenuItem[] = [
    {
      label: 'Terminal',
      shortcut: '⌘T',
      icon: <CommandLineIcon className="w-3.5 h-3.5" />,
      onClick: () => launch(agent({}))
    },
    {
      label: 'Claude Code',
      shortcut: '⌘N',
      icon: <ClaudeLogo className="w-3.5 h-3.5" />,
      onClick: () => launch(agent({ claudeMode: true }))
    },
    {
      label: 'Claude Code (skip permissions)',
      shortcut: '⌘D',
      icon: <ClaudeLogo className="w-3.5 h-3.5" />,
      onClick: () => launch(agent({ claudeMode: true, dangerousMode: true }))
    },
    {
      label: 'Claude Agents',
      shortcut: '⌘⇧A',
      icon: <ClaudeLogo className="w-3.5 h-3.5" />,
      onClick: () => launch(agent({ claudeAgentsMode: true }))
    },
    {
      label: 'Antigravity CLI',
      shortcut: '⌘I',
      icon: <AntigravityLogo className="w-3.5 h-3.5" />,
      onClick: () => launch(agent({ antigravityMode: true }))
    },
    {
      label: 'Codex CLI',
      shortcut: '⌘U',
      icon: <CodexLogo className="w-3.5 h-3.5" />,
      onClick: () => launch(agent({ codexMode: true }))
    }
  ]

  for (const dir of recentDirs.slice(0, RECENT_MENU_LIMIT)) {
    items.push({
      label: shortenPath(dir),
      icon: <FolderIcon className="w-3.5 h-3.5" />,
      onClick: () => launch({ ...defaultLaunchOptions(), cwd: dir })
    })
  }

  items.push({
    label: 'Other folder...',
    icon: <FolderOpenIcon className="w-3.5 h-3.5" />,
    onClick: () => launch({ ...defaultLaunchOptions(), forcePicker: true })
  })

  return items
}
