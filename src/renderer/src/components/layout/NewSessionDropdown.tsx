import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { useAgentStore } from '../../store/agent-store'
import { useLocationStore } from '../../store/location-store'
import { useClaudeProfileStore, type ClaudeProfile } from '../../store/claude-profile-store'
import { useSessionDirStore, refreshRecentSessionDirs } from '../../store/session-dir-store'
import {
  defaultLaunchOptions,
  dirBasename,
  dirParent,
  RECENT_MENU_LIMIT,
  type NewSessionLaunchOptions
} from './new-session-menu'
import {
  PencilSquareIcon,
  CommandLineIcon,
  BoltIcon,
  CheckIcon,
  FolderIcon,
  FolderOpenIcon
} from '@heroicons/react/24/outline'
import { AgentPickerPopover } from '../agents/AgentPickerPopover'
import { ClaudeLogo, AntigravityLogo, CodexLogo } from '../icons/cli-logos'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent
} from '../ui/dropdown-menu'

interface NewSessionDropdownProps {
  onNewSession: (options: NewSessionLaunchOptions) => void
  loading: boolean
  /** Right-click on the trigger, for the sidebar's context menu. */
  onTriggerContextMenu?: (e: React.MouseEvent) => void
}

/** Dimmed folder the row will open in, so the target is never a surprise. */
function TargetDirHint({ dir, choosing }: { dir: string | null; choosing: boolean }): ReactNode {
  if (choosing) {
    return <span className="ml-auto text-[11px] text-text-tertiary">Choose folder</span>
  }
  if (!dir) return null
  return (
    <span className="ml-auto max-w-[7rem] truncate text-[11px] text-text-tertiary" title={dir}>
      {dirBasename(dir)}
    </span>
  )
}

export function NewSessionDropdown({ onNewSession, loading, onTriggerContextMenu }: NewSessionDropdownProps) {
  const [open, setOpen] = useState(false)
  const [agentPickerOpen, setAgentPickerOpen] = useState(false)
  const btnRef = useRef<HTMLButtonElement | null>(null)
  const agents = useAgentStore((s) => s.agents)
  const locations = useLocationStore((s) => s.locations)
  const profiles = useClaudeProfileStore((s) => s.profiles)
  const selectedProfileId = useClaudeProfileStore((s) => s.selectedProfileId)
  const recentDirs = useSessionDirStore((s) => s.recentDirs)
  const dirMode = useSessionDirStore((s) => s.mode)

  const connectedRemoteLocations = locations.filter(
    (l) => l.type === 'remote' && l.status === 'connected'
  )
  const hasRemoteLocations = connectedRemoteLocations.length > 0
  const hasAgentLocations = agents.length > 0
  const multiProfile = profiles.length > 1

  // Directory the primary rows will use. Null while the preference asks every
  // time, or before any session has been opened, so the picker still runs.
  const targetDir = dirMode === 'lastUsed' ? recentDirs[0] ?? null : null
  const recentList = recentDirs.slice(0, RECENT_MENU_LIMIT)

  // Load the saved list, dropping folders that no longer exist on disk.
  useEffect(() => {
    refreshRecentSessionDirs()
  }, [open])

  // Option turns any row into "pick a folder". Tracked live so the rows can say
  // so while the key is down. The pointerdown listener is in the capture phase,
  // which runs before the click that selects an item.
  const [optionHeld, setOptionHeld] = useState(false)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => setOptionHeld(e.altKey)
    const onPointer = (e: PointerEvent): void => setOptionHeld(e.altKey)
    window.addEventListener('keydown', onKey)
    window.addEventListener('keyup', onKey)
    window.addEventListener('pointerdown', onPointer, true)
    window.addEventListener('pointermove', onPointer)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('keyup', onKey)
      window.removeEventListener('pointerdown', onPointer, true)
      window.removeEventListener('pointermove', onPointer)
    }
  }, [open])

  const handleOption = useCallback(
    (claudeMode: boolean, dangerousMode: boolean, locationId?: string, antigravityMode?: boolean, codexMode?: boolean, claudeAgentsMode?: boolean, claudeProfileId?: string) => {
      const forcePicker = optionHeld
      setOpen(false)
      onNewSession({
        claudeMode,
        antigravityMode: antigravityMode ?? false,
        codexMode: codexMode ?? false,
        claudeAgentsMode: claudeAgentsMode ?? false,
        dangerousMode,
        locationId,
        claudeProfileId,
        forcePicker: locationId ? undefined : forcePicker
      })
    },
    [onNewSession, optionHeld]
  )

  const launchInDir = useCallback(
    (cwd: string) => {
      setOpen(false)
      onNewSession({ ...defaultLaunchOptions(), cwd })
    },
    [onNewSession]
  )

  const launchWithPicker = useCallback(() => {
    setOpen(false)
    onNewSession({ ...defaultLaunchOptions(), forcePicker: true })
  }, [onNewSession])

  /** A Claude launch row. With >1 profile it becomes a submenu whose entries
   *  each launch under a specific account; otherwise a plain one-click item. */
  const renderClaudeEntry = useCallback(
    (
      label: string,
      shortcut: string | undefined,
      launch: (profileId?: string) => void
    ) => {
      if (!multiProfile) {
        return (
          <DropdownMenuItem onSelect={() => launch()}>
            <ClaudeLogo className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
            <span className="flex-1">{label}</span>
            <TargetDirHint dir={targetDir} choosing={optionHeld} />
            {shortcut && <DropdownMenuShortcut>{shortcut}</DropdownMenuShortcut>}
          </DropdownMenuItem>
        )
      }
      return (
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <ClaudeLogo className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
            <span className="flex-1">{label}</span>
            <TargetDirHint dir={targetDir} choosing={optionHeld} />
            <span className="text-text-tertiary">{'›'}</span>
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            <DropdownMenuLabel>Account</DropdownMenuLabel>
            {profiles.map((p: ClaudeProfile) => (
              <DropdownMenuItem key={p.id} onSelect={() => launch(p.id)}>
                <span className="flex-1 truncate">{p.label}</span>
                {p.id === selectedProfileId && (
                  <CheckIcon className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      )
    },
    [multiProfile, profiles, selectedProfileId, targetDir, optionHeld]
  )

  return (
    <div className="relative">
      <DropdownMenu
        open={open}
        onOpenChange={(next) => {
          setOpen(next)
          if (!next) setOptionHeld(false)
        }}
      >
        <DropdownMenuTrigger asChild>
          <button
            ref={(el) => { btnRef.current = el }}
            disabled={loading}
            onContextMenu={onTriggerContextMenu}
            className="sidebar-item w-full disabled:opacity-50"
            title="New session"
          >
            <PencilSquareIcon className="sidebar-tab-icon flex-shrink-0 text-text-tertiary" />
            <span className="truncate">New session</span>
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent animated open={open} side="right" align="start" sideOffset={16} alignOffset={6}>
          {hasRemoteLocations && (
            <DropdownMenuLabel>This Mac</DropdownMenuLabel>
          )}

          <DropdownMenuItem onSelect={() => handleOption(false, false)}>
            <CommandLineIcon className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
            <span className="flex-1">Terminal</span>
            <TargetDirHint dir={targetDir} choosing={optionHeld} />
            <DropdownMenuShortcut>{'⌘T'}</DropdownMenuShortcut>
          </DropdownMenuItem>
          {renderClaudeEntry('Claude Code', '⌘N', (profileId) =>
            handleOption(true, false, undefined, false, false, false, profileId)
          )}
          {renderClaudeEntry('Claude Code (skip permissions)', '⌘D', (profileId) =>
            handleOption(true, true, undefined, false, false, false, profileId)
          )}
          {renderClaudeEntry('Claude Agents', '⌘⇧A', (profileId) =>
            handleOption(false, false, undefined, false, false, true, profileId)
          )}
          <DropdownMenuItem onSelect={() => handleOption(false, false, undefined, true)}>
            <AntigravityLogo className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
            <span className="flex-1">Antigravity CLI</span>
            <TargetDirHint dir={targetDir} choosing={optionHeld} />
            <DropdownMenuShortcut>{'⌘I'}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => handleOption(false, false, undefined, false, true)}>
            <CodexLogo className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
            <span className="flex-1">Codex CLI</span>
            <TargetDirHint dir={targetDir} choosing={optionHeld} />
            <DropdownMenuShortcut>{'⌘U'}</DropdownMenuShortcut>
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {recentList.length > 0 && (
            <>
              <DropdownMenuLabel>Recent folders</DropdownMenuLabel>
              {recentList.map((dir) => (
                <DropdownMenuItem key={dir} onSelect={() => launchInDir(dir)}>
                  <FolderIcon className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
                  <span className="truncate">{dirBasename(dir)}</span>
                  <span
                    className="ml-auto max-w-[9rem] truncate text-[11px] text-text-tertiary"
                    title={dir}
                  >
                    {dirParent(dir)}
                  </span>
                </DropdownMenuItem>
              ))}
            </>
          )}
          <DropdownMenuItem onSelect={launchWithPicker}>
            <FolderOpenIcon className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
            <span className="flex-1">Other folder...</span>
            <DropdownMenuShortcut>{'⌥'}</DropdownMenuShortcut>
          </DropdownMenuItem>
          <div className="px-3 pt-1 pb-0.5 text-[11px] text-text-tertiary">
            Hold Option to choose a folder
          </div>

          {connectedRemoteLocations.map((loc) => (
            <div key={loc.id}>
              <DropdownMenuSeparator />
              <DropdownMenuLabel>
                <span className="flex items-center gap-1.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500 flex-shrink-0" />
                  <span className="truncate">{loc.name}</span>
                  {loc.host && (
                    <span className="text-text-tertiary/60 font-normal normal-case">({loc.host})</span>
                  )}
                </span>
              </DropdownMenuLabel>
              <DropdownMenuItem onSelect={() => handleOption(false, false, loc.id)}>
                <CommandLineIcon className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
                <span className="flex-1">Terminal</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => handleOption(true, false, loc.id)}>
                <ClaudeLogo className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
                <span className="flex-1">Claude Code</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => handleOption(false, false, loc.id, true)}>
                <AntigravityLogo className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
                <span className="flex-1">Antigravity CLI</span>
              </DropdownMenuItem>
              <DropdownMenuItem onSelect={() => handleOption(false, false, loc.id, false, true)}>
                <CodexLogo className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
                <span className="flex-1">Codex CLI</span>
              </DropdownMenuItem>
            </div>
          ))}

          {hasAgentLocations && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onSelect={() => {
                setOpen(false)
                setAgentPickerOpen(true)
              }}>
                <BoltIcon className="w-3.5 h-3.5 flex-shrink-0 text-text-tertiary" />
                <span className="flex-1">OpenClaw Agent...</span>
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {agentPickerOpen && (
        <AgentPickerPopover
          anchorRef={btnRef}
          onClose={() => setAgentPickerOpen(false)}
        />
      )}
    </div>
  )
}
