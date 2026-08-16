import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { CheckIcon, NoSymbolIcon, TrashIcon } from '@heroicons/react/24/outline'
import { useSessionStore } from '../../store/session-store'
import { SettingsSection, SettingsCard, SettingsRow, ToggleRow } from './primitives'
import type { RemoteDevice, RemoteStatus } from '../../../../shared/remote-protocol'

/** Status before the first round-trip to main comes back. */
const initialStatus: RemoteStatus = {
  enabled: false,
  running: false,
  port: null,
  requireApproval: true,
  deviceCount: 0,
  pendingCount: 0
}

/** Same shape as the git views' formatter, over an epoch timestamp. */
function relativeTime(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000)
  if (seconds < 60) return 'just now'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.floor(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.floor(months / 12)}y ago`
}

function DeviceRow({
  device,
  onApprove,
  onRevoke
}: {
  device: RemoteDevice
  onApprove: (clientId: string) => void
  onRevoke: (clientId: string) => void
}): ReactNode {
  const pending = device.status === 'pending'
  const revoked = device.status === 'revoked'

  return (
    <div className="settings-row">
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2">
          <span className="settings-row-title truncate">{device.deviceName}</span>
          {pending && (
            <span className="badge badge-uppercase bg-amber-500/15 text-amber-500">Pending</span>
          )}
          {revoked && (
            <span className="badge badge-uppercase bg-surface-200 text-text-tertiary">Revoked</span>
          )}
        </div>
        <span className="settings-row-description">
          {device.appVersion
            ? `Version ${device.appVersion}. Last seen ${relativeTime(device.lastSeenAt)}.`
            : `Last seen ${relativeTime(device.lastSeenAt)}.`}
        </span>
      </div>
      <div className="flex items-center gap-1.5 flex-shrink-0">
        {(pending || revoked) && (
          <button onClick={() => onApprove(device.clientId)} className="btn-secondary btn-compact">
            <CheckIcon className="w-3.5 h-3.5" />
            Approve
          </button>
        )}
        {pending && (
          <button
            onClick={() => onRevoke(device.clientId)}
            className="btn-icon btn-icon-xs hover:text-red-400"
            title="Deny this device"
          >
            <NoSymbolIcon className="w-4 h-4" />
          </button>
        )}
        {!pending && !revoked && (
          <button
            onClick={() => onRevoke(device.clientId)}
            className="btn-icon btn-icon-xs hover:text-red-400"
            title="Revoke this device"
          >
            <TrashIcon className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * Remote Access. Serves Clave's session model to a remote client (the iPadOS
 * app) over a WebSocket bound to loopback, so reaching it requires an SSH login
 * to this Mac first. Off by default; main owns the server and this panel is a
 * view over the `RemoteStatus` it returns.
 */
export function RemoteAccessSection(): ReactNode {
  const remoteAccessEnabled = useSessionStore((s) => s.remoteAccessEnabled)
  const setRemoteAccessEnabled = useSessionStore((s) => s.setRemoteAccessEnabled)
  const [status, setStatus] = useState<RemoteStatus>({
    ...initialStatus,
    enabled: remoteAccessEnabled
  })
  const [devices, setDevices] = useState<RemoteDevice[]>([])
  const [busy, setBusy] = useState(false)

  // Load the real state from main, then follow the device roster live so a
  // device that pairs while this panel is open shows up without a reopen.
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const [next, list] = await Promise.all([
          window.electronAPI.remoteGetStatus(),
          window.electronAPI.remoteListDevices()
        ])
        if (cancelled) return
        setStatus(next)
        setDevices(list)
        setRemoteAccessEnabled(next.enabled)
      } catch {
        /* Remote access is unavailable in this build. Leave the defaults. */
      }
    })()
    const unsubscribe = window.electronAPI.onRemoteDevicesUpdated((list) => setDevices(list))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [setRemoteAccessEnabled])

  const handleToggle = useCallback(
    async (enabled: boolean) => {
      setBusy(true)
      setRemoteAccessEnabled(enabled)
      try {
        const next = await window.electronAPI.remoteSetEnabled(enabled)
        setStatus(next)
        setRemoteAccessEnabled(next.enabled)
        setDevices(await window.electronAPI.remoteListDevices())
      } catch (err) {
        setStatus((prev) => ({
          ...prev,
          enabled,
          running: false,
          error: err instanceof Error ? err.message : String(err)
        }))
      } finally {
        setBusy(false)
      }
    },
    [setRemoteAccessEnabled]
  )

  const handleRequireApproval = useCallback(async (requireApproval: boolean) => {
    setStatus((prev) => ({ ...prev, requireApproval }))
    try {
      setStatus(await window.electronAPI.remoteSetRequireApproval(requireApproval))
    } catch {
      setStatus((prev) => ({ ...prev, requireApproval: !requireApproval }))
    }
  }, [])

  const handleApprove = useCallback((clientId: string) => {
    void window.electronAPI.remoteApproveDevice(clientId).then(setDevices)
  }, [])

  const handleRevoke = useCallback((clientId: string) => {
    void window.electronAPI.remoteRevokeDevice(clientId).then(setDevices)
  }, [])

  // Devices waiting on a decision first, then the rest by how recently they
  // were seen.
  const rank = (device: RemoteDevice): number => (device.status === 'pending' ? 0 : 1)
  const sortedDevices = [...devices].sort(
    (a, b) => rank(a) - rank(b) || b.lastSeenAt - a.lastSeenAt
  )

  return (
    <SettingsSection
      title="Remote Access"
      description="Reach your sessions from the Clave app on another device. The connection is served on this Mac only, so a client has to sign in over SSH to reach it."
    >
      <SettingsCard>
        <ToggleRow
          label="Enable remote access"
          description={
            status.error
              ? `The remote server could not start: ${status.error}`
              : status.running && status.port !== null
                ? `Listening on 127.0.0.1:${status.port}. Forward that port over SSH to connect.`
                : 'Serve your session list and let a paired device open, focus, and close tabs. Terminal output travels over its own SSH channel.'
          }
          checked={status.enabled}
          onChange={(value) => void handleToggle(value)}
          disabled={busy}
        />
        <ToggleRow
          label="Require approval for new devices"
          description="Hold a device's first connection until you approve it here. Devices you already approved stay connected."
          checked={status.requireApproval}
          onChange={(value) => void handleRequireApproval(value)}
          disabled={busy}
        />
      </SettingsCard>

      <div className="mt-3">
        <h3 className="settings-section-title mb-1.5">Devices</h3>
        <SettingsCard>
          {sortedDevices.length === 0 ? (
            <SettingsRow
              label="No devices yet"
              description="Devices appear here the first time they connect."
            />
          ) : (
            sortedDevices.map((device) => (
              <DeviceRow
                key={device.clientId}
                device={device}
                onApprove={handleApprove}
                onRevoke={handleRevoke}
              />
            ))
          )}
        </SettingsCard>
      </div>
    </SettingsSection>
  )
}
