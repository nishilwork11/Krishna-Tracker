/**
 * Preload bridge: the ONLY surface the renderer has into the app.
 *
 * Runs in a sandboxed, context-isolated preload, so it may only use `contextBridge` and
 * `ipcRenderer`. It exposes a fixed set of typed functions as `window.tracker`; raw
 * `ipcRenderer` is never handed to the page.
 */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import { IpcChannel, type TrackerApi, type TrackerState } from '@shared/ipc'

const api: TrackerApi = {
  getState: () => ipcRenderer.invoke(IpcChannel.GetState),
  onState: (cb) => {
    const listener = (_e: IpcRendererEvent, s: TrackerState): void => cb(s)
    ipcRenderer.on(IpcChannel.StateChanged, listener)
    return () => ipcRenderer.removeListener(IpcChannel.StateChanged, listener)
  },
  login: (url, email, password) => ipcRenderer.invoke(IpcChannel.Login, url, email, password),
  logout: () => ipcRenderer.invoke(IpcChannel.Logout),
  start: (projectId) => ipcRenderer.invoke(IpcChannel.Start, projectId ?? null),
  pause: () => ipcRenderer.invoke(IpcChannel.Pause),
  resume: () => ipcRenderer.invoke(IpcChannel.Resume),
  stop: () => ipcRenderer.invoke(IpcChannel.Stop),
  syncNow: () => ipcRenderer.invoke(IpcChannel.SyncNow),
  getActivity: (date) => ipcRenderer.invoke(IpcChannel.GetActivity, date),
  getScreenshotImage: (id, pending) => ipcRenderer.invoke(IpcChannel.GetScreenshotImage, id, pending),
  setLaunchAtStartup: (enabled) => ipcRenderer.invoke(IpcChannel.SetLaunchAtStartup, enabled),
  dismissNotice: () => ipcRenderer.invoke(IpcChannel.DismissNotice)
}

contextBridge.exposeInMainWorld('tracker', api)
