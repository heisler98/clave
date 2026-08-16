import { ipcMain } from 'electron'
import { REMOTE_IPC, type RemoteSnapshot } from '../../shared/remote-protocol'
import {
  getRemoteStatus,
  pushSnapshot,
  startRemoteServer,
  stopRemoteServer
} from '../remote/remote-server'
import {
  approveDevice,
  listDevices,
  onDevicesChanged,
  revokeDevice,
  setRemoteEnabled,
  setRequireApproval
} from '../remote/remote-state'
import { getMainWindow } from '../window-utils'

/** Cheap shape guard for the one `send` channel here. Everything else is an
 *  `invoke` with a primitive argument, but the snapshot arrives as a structured
 *  object on a fire-and-forget channel, so a malformed push should be dropped
 *  rather than corrupt the cached model every remote client reads from. */
function isSnapshot(value: unknown): value is RemoteSnapshot {
  if (!value || typeof value !== 'object') return false
  const s = value as Partial<RemoteSnapshot>
  return Array.isArray(s.sessions) && Array.isArray(s.groups) && Array.isArray(s.pinnedGroups)
}

export function registerRemoteHandlers(): void {
  ipcMain.handle(REMOTE_IPC.getStatus, () => getRemoteStatus())

  // Enabling starts the server and returns the resulting status, so the
  // Settings toggle can show the bound port (or the failure) without a second
  // round trip.
  ipcMain.handle(REMOTE_IPC.setEnabled, async (_event, enabled: unknown) => {
    const on = enabled === true
    setRemoteEnabled(on)
    if (!on) {
      stopRemoteServer()
      return getRemoteStatus()
    }
    return startRemoteServer()
  })

  ipcMain.handle(REMOTE_IPC.setRequireApproval, (_event, requireApproval: unknown) => {
    setRequireApproval(requireApproval === true)
    return getRemoteStatus()
  })

  ipcMain.handle(REMOTE_IPC.listDevices, () => listDevices())

  ipcMain.handle(REMOTE_IPC.approveDevice, (_event, clientId: unknown) =>
    typeof clientId === 'string' ? approveDevice(clientId) : listDevices()
  )

  ipcMain.handle(REMOTE_IPC.revokeDevice, (_event, clientId: unknown) =>
    typeof clientId === 'string' ? revokeDevice(clientId) : listDevices()
  )

  // The renderer owns the UI model (tabs, groups, activity); it pushes on
  // change and the remote server merges in the tmux facts only main knows.
  ipcMain.on(REMOTE_IPC.pushSnapshot, (_event, snapshot: unknown) => {
    if (isSnapshot(snapshot)) pushSnapshot(snapshot)
  })

  // Pairing happens on a background socket, so the Settings panel needs to hear
  // about a new device while it is already open.
  onDevicesChanged((devices) => {
    getMainWindow()?.webContents.send(REMOTE_IPC.devicesUpdated, devices)
  })
}
