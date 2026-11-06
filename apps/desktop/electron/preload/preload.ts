import { contextBridge, ipcRenderer } from 'electron';
import type { BackendRequest, BackendResponse, DesktopBridge } from '../../src/types/desktop-bridge';

const bridge: DesktopBridge = {
  getBackendState: () => ipcRenderer.invoke('backend:state'),
  request: <T = unknown>(input: BackendRequest) =>
    ipcRenderer.invoke('backend:request', input) as Promise<BackendResponse<T>>,
};

contextBridge.exposeInMainWorld('teachforge', bridge);
