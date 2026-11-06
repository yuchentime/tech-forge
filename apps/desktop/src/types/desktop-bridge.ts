export type BackendRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
};

export type BackendResponse<T = unknown> = {
  status: number;
  data: T;
};

export type DesktopBridge = {
  getBackendState(): Promise<{ ready: boolean; port: number | null }>;
  request<T = unknown>(input: BackendRequest): Promise<BackendResponse<T>>;
};

declare global {
  interface Window {
    teachforge: DesktopBridge;
  }
}
