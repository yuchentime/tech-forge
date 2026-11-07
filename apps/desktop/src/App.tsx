import { useCallback, useEffect, useState } from 'react';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
} from '@assistant-ui/react';
import { agentChatAdapter } from './features/agent/agent-chat-adapter';
import { AgentChatPage } from './features/agent/AgentChatPage';
import { hasDesktopBridge } from './types/desktop-bridge';

type Health = {
  status: string;
  service: string;
  timestamp: string;
};

/** Owns the desktop shell, long-lived Agent runtime, and backend health state. */
export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState('');
  const runtime = useLocalRuntime(agentChatAdapter);

  /** Checks the local backend health endpoint through the controlled JSON bridge. */
  const loadWorkspace = useCallback(async () => {
    if (!hasDesktopBridge()) {
      setHealth(null);
      setError('请通过 TeachForge 桌面应用打开；浏览器预览无法连接本地服务。');
      console.error('[TeachForge][backend.health] desktop_bridge_unavailable');
      return;
    }

    let httpStatus: number | null = null;
    try {
      const response = await window.teachforge.request<Health>({
        method: 'GET',
        path: '/api/health',
      });
      httpStatus = response.status;
      if (response.status !== 200) {
        throw new Error('本地服务返回了错误状态。');
      }
      setHealth(response.data);
      setError('');
    } catch (cause) {
      setHealth(null);
      setError(cause instanceof Error ? cause.message : '连接本地服务失败。');
      console.error('[TeachForge][backend.health] request_failed', {
        httpStatus,
        errorName: cause instanceof Error ? cause.name : 'UnknownError',
      });
    }
  }, []);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <main className="min-h-screen bg-[#f0f2ed] p-2 text-stone-900">
        <div className="mx-auto flex min-h-[calc(100vh-1rem)] max-w-[1600px] flex-col lg:flex-row">
          <aside className="flex shrink-0 items-center gap-3 px-3 py-2 lg:w-[228px] lg:items-start lg:px-5 lg:py-5">
            <div aria-hidden="true" className="relative size-9 shrink-0">
              <span className="absolute left-1 top-1 h-6 w-5 border-2 border-emerald-900" />
              <span className="absolute bottom-1 right-1 h-6 w-5 border-2 border-emerald-700 bg-[#f0f2ed]" />
            </div>
            <div>
              <p className="text-sm font-semibold tracking-wide">TeachForge</p>
              <p className="text-xs text-stone-600">本地教学工作台</p>
            </div>
          </aside>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:pr-2 lg:pb-2">
            <header className="flex h-12 shrink-0 items-center justify-between px-3 lg:px-5">
              <p className="text-sm font-medium text-stone-700">Agent 对话</p>
              <div
                aria-live="polite"
                className="flex items-center gap-2 text-xs text-stone-600"
                title={error || undefined}
              >
                <span
                  className={`size-2 rounded-full ${health ? 'bg-emerald-700' : 'bg-amber-600'}`}
                />
                {health
                  ? '本地服务已连接'
                  : !hasDesktopBridge()
                    ? '请在桌面应用打开'
                    : error
                      ? '本地服务连接异常'
                      : '正在连接服务'}
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-[#e5e8e4] bg-white">
              <section aria-label="Agent 对话页面" className="h-full min-h-[32rem]">
                <AgentChatPage runtime={runtime} />
              </section>
            </div>
          </div>
        </div>
      </main>
    </AssistantRuntimeProvider>
  );
}
