import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'
import { app } from 'electron'
import type { RemoteDevice } from '../../shared/remote-protocol'

/**
 * Persistence for the remote-access service: the bearer token and bound port,
 * the two user preferences that gate it, and the paired-device roster.
 *
 * Two files, both 0600 and both written tmp-then-rename (the same dance as
 * `mcp-runtime.ts`), because a kill mid-write must never leave a truncated
 * token file that reads back as "no token" and takes the server down with it.
 *
 *   remote-server.json   port, token, enabled, requireApproval
 *   remote-devices.json  the device roster
 *
 * The token lives in a file rather than on a command line so it never appears
 * in `ps` or in a tmux-visible argv, exactly like the MCP session configs.
 */

interface RemoteServerFile {
  port: number
  token: string
  /** Default off. This service grants full control of every agent session. */
  enabled: boolean
  requireApproval: boolean
}

const DEFAULTS: Omit<RemoteServerFile, 'token'> = {
  port: 0,
  enabled: false,
  requireApproval: true
}

let serverCache: RemoteServerFile | null = null
let deviceCache: Map<string, RemoteDevice> | null = null

const deviceListeners = new Set<(devices: RemoteDevice[]) => void>()

function serverFilePath(): string {
  return path.join(app.getPath('userData'), 'remote-server.json')
}

function devicesFilePath(): string {
  return path.join(app.getPath('userData'), 'remote-devices.json')
}

/** Write-then-rename at 0600, so a partial write can never become the file. */
function writePrivateJson(filePath: string, value: unknown): void {
  const tmp = `${filePath}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf-8', mode: 0o600 })
  fs.renameSync(tmp, filePath)
  fs.chmodSync(filePath, 0o600)
}

function readServerFile(): RemoteServerFile {
  if (serverCache) return serverCache
  try {
    const data = JSON.parse(fs.readFileSync(serverFilePath(), 'utf-8')) as Partial<RemoteServerFile>
    if (typeof data.token === 'string' && data.token.length > 0) {
      const port = typeof data.port === 'number' && Number.isInteger(data.port) ? data.port : 0
      serverCache = {
        port: port > 0 ? port : DEFAULTS.port,
        token: data.token,
        enabled: data.enabled === true,
        requireApproval: data.requireApproval !== false
      }
      return serverCache
    }
  } catch {
    /* fall through to fresh state */
  }
  // No usable file: mint a token now so callers never see a tokenless state.
  // It is not written until something asks to persist, which keeps a read-only
  // userData directory from failing app startup.
  serverCache = { ...DEFAULTS, token: randomBytes(32).toString('hex') }
  return serverCache
}

function persistServerFile(): void {
  try {
    writePrivateJson(serverFilePath(), readServerFile())
  } catch (err) {
    console.error('[remote] failed to persist server state', err)
  }
}

/**
 * The token and the port to try first. The port is persisted because an SSH
 * forward on the client is configured against a fixed local port; coming back
 * on the same one after a restart means the iPad's saved host keeps working.
 * Port 0 means "pick an ephemeral port".
 */
export function loadRemoteServerState(): { port: number; token: string } {
  const state = readServerFile()
  return { port: state.port, token: state.token }
}

export function saveRemoteServerState(port: number, token: string): void {
  const state = readServerFile()
  state.port = port
  state.token = token
  persistServerFile()
}

export function isRemoteEnabled(): boolean {
  return readServerFile().enabled
}

export function setRemoteEnabled(v: boolean): void {
  readServerFile().enabled = v
  persistServerFile()
}

export function getRequireApproval(): boolean {
  return readServerFile().requireApproval
}

export function setRequireApproval(v: boolean): void {
  readServerFile().requireApproval = v
  persistServerFile()
}

// ── Device roster ──────────────────────────────────────────────────────────

function readDevices(): Map<string, RemoteDevice> {
  if (deviceCache) return deviceCache
  const map = new Map<string, RemoteDevice>()
  try {
    const data = JSON.parse(fs.readFileSync(devicesFilePath(), 'utf-8')) as {
      devices?: RemoteDevice[]
    }
    for (const device of data.devices ?? []) {
      if (typeof device?.clientId === 'string' && device.clientId) map.set(device.clientId, device)
    }
  } catch {
    /* no roster yet */
  }
  deviceCache = map
  return map
}

function persistDevices(): void {
  try {
    writePrivateJson(devicesFilePath(), { devices: listDevices() })
  } catch (err) {
    console.error('[remote] failed to persist device roster', err)
  }
}

function notifyDevicesChanged(): RemoteDevice[] {
  const devices = listDevices()
  for (const listener of deviceListeners) {
    try {
      listener(devices)
    } catch (err) {
      console.error('[remote] device listener threw', err)
    }
  }
  return devices
}

/** Newest contact first, which is the order the Settings list wants. */
export function listDevices(): RemoteDevice[] {
  return Array.from(readDevices().values()).sort((a, b) => b.lastSeenAt - a.lastSeenAt)
}

export function getDevice(clientId: string): RemoteDevice | undefined {
  return readDevices().get(clientId)
}

/**
 * Record a connection from a device. A known device keeps its status, so a
 * revoked client id cannot re-pair itself by reconnecting with a new name.
 * An unknown one starts `pending` when approval is required and `approved`
 * when it is not.
 */
export function upsertDevice(
  clientId: string,
  deviceName: string,
  appVersion?: string
): RemoteDevice {
  const devices = readDevices()
  const now = Date.now()
  const existing = devices.get(clientId)
  const device: RemoteDevice = existing
    ? { ...existing, deviceName, appVersion: appVersion ?? existing.appVersion, lastSeenAt: now }
    : {
        clientId,
        deviceName,
        status: getRequireApproval() ? 'pending' : 'approved',
        firstSeenAt: now,
        lastSeenAt: now,
        appVersion
      }
  devices.set(clientId, device)
  persistDevices()
  notifyDevicesChanged()
  return device
}

export function approveDevice(clientId: string): RemoteDevice[] {
  const device = readDevices().get(clientId)
  if (device) {
    device.status = 'approved'
    persistDevices()
  }
  return notifyDevicesChanged()
}

export function revokeDevice(clientId: string): RemoteDevice[] {
  const device = readDevices().get(clientId)
  if (device) {
    device.status = 'revoked'
    persistDevices()
  }
  return notifyDevicesChanged()
}

/** Fires on every roster change, so the server can drop revoked sockets and
 *  the Settings panel can refresh without polling. */
export function onDevicesChanged(cb: (devices: RemoteDevice[]) => void): void {
  deviceListeners.add(cb)
}
