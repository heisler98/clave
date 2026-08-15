import { ipcMain, Notification, BrowserWindow, app, type WebContents } from 'electron'
import { getPreference } from './ipc-handlers/clave-file-handlers'

export type NotificationStatus = 'shown' | 'skipped-focused' | 'skipped-disabled' | 'unsupported'

/**
 * When Clave is allowed to post a native notification.
 *
 * - `'always'` (default) every notification fires, including ones for the tab
 *   currently on screen. The window being frontmost says nothing about whether
 *   the user is looking at the tab that needs them, so focus is not a signal.
 * - `'unfocused-window'` opt-in quiet mode: suppress while the Clave window is
 *   focused. The only value that ever yields `'skipped-focused'`.
 * - `'off'` suppress everything.
 */
export type NotificationMode = 'always' | 'unfocused-window' | 'off'

export interface SessionNotificationRequest {
  title: string
  body: string
  /** Clave session id the notification belongs to. Clicking focuses this tab. */
  sessionId: string
}

const DEFAULT_MODE: NotificationMode = 'always'

/** Read the persisted mode. Anything unrecognized (including an absent key)
 *  degrades to `'always'`, so a corrupt preferences file can never silence
 *  notifications. */
export function getNotificationMode(): NotificationMode {
  const raw = getPreference('notificationMode')
  return raw === 'always' || raw === 'unfocused-window' || raw === 'off' ? raw : DEFAULT_MODE
}

/** The window a notification belongs to: the sender's window for renderer-driven
 *  calls, otherwise the app's window (Clave is single-window in practice). */
function targetWindow(sender?: WebContents): BrowserWindow | null {
  if (sender && !sender.isDestroyed()) {
    const win = BrowserWindow.fromWebContents(sender)
    if (win && !win.isDestroyed()) return win
  }
  const windows = BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed())
  return windows.find((w) => w.isFocused()) ?? windows[0] ?? null
}

/**
 * Post a native notification for a session. The single notification code path in
 * the app: the renderer's `notification:show` IPC, the `clave_notify` MCP tool,
 * and the main-process hook watcher (agent-event-manager) all land here, so
 * click-to-focus and the dock bounce behave identically for every source.
 *
 * `sender` is set for renderer-driven calls. Main-process callers omit it.
 */
export function showSessionNotification(
  options: SessionNotificationRequest,
  sender?: WebContents
): NotificationStatus {
  if (!Notification.isSupported()) {
    console.log('[notification] Notifications not supported on this system')
    return 'unsupported'
  }

  const mode = getNotificationMode()
  if (mode === 'off') {
    return 'skipped-disabled'
  }

  const win = targetWindow(sender)

  if (mode === 'unfocused-window' && win?.isFocused()) {
    console.log('[notification] Skipped (window is focused):', options.body)
    return 'skipped-focused'
  }

  console.log('[notification] Showing:', options.title, '-', options.body)

  const notification = new Notification({
    title: options.title,
    body: options.body,
    silent: false
  })

  notification.on('click', () => {
    if (win && !win.isDestroyed()) {
      win.show()
      win.focus()
    }
    const receiver = win && !win.isDestroyed() ? win.webContents : sender
    if (receiver && !receiver.isDestroyed()) {
      receiver.send('notification:clicked', options.sessionId)
    }
  })

  notification.show()
  if (process.platform === 'darwin') {
    app.dock?.bounce('informational')
  }
  return 'shown'
}

export function initNotificationManager(): void {
  ipcMain.handle(
    'notification:show',
    (event, options: SessionNotificationRequest): NotificationStatus =>
      showSessionNotification(options, event.sender)
  )
}
