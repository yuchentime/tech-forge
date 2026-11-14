import { hasDesktopBridge } from '../types/desktop-bridge';

/**
 * Sends one HTTP request through the desktop bridge.
 *
 * The Renderer never knows the backend port; the main process owns it. A browser preview has no
 * bridge at all, so the call fails with copy the user can act on instead of a network error.
 */
export async function requestBackend(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  body?: unknown,
): Promise<{ status: number; data: unknown }> {
  if (!hasDesktopBridge()) {
    throw new Error('请通过 TeachForge 桌面应用访问本地数据。');
  }
  return window.teachforge.request<unknown>(
    body === undefined ? { method, path } : { method, path, body },
  );
}
