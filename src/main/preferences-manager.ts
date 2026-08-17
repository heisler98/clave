import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

export type AppIcon = 'dark' | 'light' | 'claude'

interface Preferences {
  appIcon: AppIcon
  telemetryEnabled: boolean
  telemetryInstallId: string | null
  telemetryLastPingAt: string | null
  telemetryNoticeShown: boolean
  feedbackPromptCollapsed: boolean
  missionControlOverlayEnabled: boolean
}

const DEFAULTS: Preferences = {
  appIcon: 'dark',
  telemetryEnabled: true,
  telemetryInstallId: null,
  telemetryLastPingAt: null,
  telemetryNoticeShown: false,
  feedbackPromptCollapsed: false,
  missionControlOverlayEnabled: true
}

// The packaged app and `npm run dev` share this file (userData resolves to the
// same folder for both on a case-insensitive disk), so a boot-time snapshot
// written back whole lets one instance erase the other's keys. The cache is
// re-read whenever the file changed on disk, and writes merge on top of the
// latest disk state — same discipline as the clave-preferences.json manager in
// `ipc-handlers/clave-file-handlers.ts`, where the hazard actually bit.
class PreferencesManager {
  private filePath: string
  private cache: Preferences
  private loadedMtimeMs = -1

  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'preferences.json')
    this.cache = this.load()
  }

  private load(): Preferences {
    try {
      this.loadedMtimeMs = fs.statSync(this.filePath).mtimeMs
      const raw = fs.readFileSync(this.filePath, 'utf-8')
      return { ...DEFAULTS, ...JSON.parse(raw) }
    } catch {
      this.loadedMtimeMs = -1
      return { ...DEFAULTS }
    }
  }

  private reloadIfChanged(): void {
    let mtimeMs = -1
    try {
      mtimeMs = fs.statSync(this.filePath).mtimeMs
    } catch {
      return // no file — nothing newer than the cache exists
    }
    if (mtimeMs !== this.loadedMtimeMs) this.cache = this.load()
  }

  private save(): void {
    fs.writeFileSync(this.filePath, JSON.stringify(this.cache, null, 2), 'utf-8')
    try {
      this.loadedMtimeMs = fs.statSync(this.filePath).mtimeMs
    } catch {
      this.loadedMtimeMs = -1
    }
  }

  get<K extends keyof Preferences>(key: K): Preferences[K] {
    this.reloadIfChanged()
    return this.cache[key]
  }

  set<K extends keyof Preferences>(key: K, value: Preferences[K]): void {
    this.reloadIfChanged()
    this.cache[key] = value
    this.save()
  }
}

export const preferencesManager = new PreferencesManager()
