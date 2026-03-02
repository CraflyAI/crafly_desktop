import { contextBridge, ipcRenderer } from "electron";

const api = {
  health: () => ipcRenderer.invoke("bridge:health"),
  getPreferences: () => ipcRenderer.invoke("preferences:get"),
  setOutputDir: () => ipcRenderer.invoke("preferences:setOutputDir"),
  openJob: () => ipcRenderer.invoke("job:open"),
  startRender: (payload: { jobPath?: string }) => ipcRenderer.invoke("render:start", payload),
  cancelRender: () => ipcRenderer.invoke("render:cancel"),
  openPath: (targetPath: string) => ipcRenderer.invoke("shell:openPath", targetPath),
  openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
  onRenderProgress: (cb: (event: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => cb(data);
    ipcRenderer.on("render:progress", handler as any);
    return () => ipcRenderer.removeListener("render:progress", handler as any);
  },
  onRenderSnapshot: (cb: (event: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => cb(data);
    ipcRenderer.on("render:snapshot", handler as any);
    return () => ipcRenderer.removeListener("render:snapshot", handler as any);
  },
  onIncomingBridgeJob: (cb: (event: unknown) => void) => {
    const handler = (_event: unknown, data: unknown) => cb(data);
    ipcRenderer.on("bridge:incoming-job", handler as any);
    return () => ipcRenderer.removeListener("bridge:incoming-job", handler as any);
  },
};

contextBridge.exposeInMainWorld("craflyDesktop", api);
