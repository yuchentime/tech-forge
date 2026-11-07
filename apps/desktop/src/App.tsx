import { useCallback, useEffect, useState, type FormEvent } from 'react';
import {
  AssistantRuntimeProvider,
  useLocalRuntime,
} from '@assistant-ui/react';
import { agentChatAdapter } from './features/agent/agent-chat-adapter';
import { AgentChatPage } from './features/agent/AgentChatPage';

type Course = {
  id: string;
  title: string;
  description: string | null;
  createdAt: string;
};

type Health = {
  status: string;
  service: string;
  timestamp: string;
};

type AppTab = 'agent' | 'course';

/** Owns the desktop shell, long-lived Agent runtime, health state, and Course prototype. */
export default function App() {
  const [activeTab, setActiveTab] = useState<AppTab>('agent');
  const [health, setHealth] = useState<Health | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const runtime = useLocalRuntime(agentChatAdapter);

  /** Refreshes existing backend health and Course prototype data through JSON IPC. */
  const loadWorkspace = useCallback(async () => {
    try {
      const [healthResponse, coursesResponse] = await Promise.all([
        window.teachforge.request<Health>({ method: 'GET', path: '/api/health' }),
        window.teachforge.request<Course[]>({ method: 'GET', path: '/api/courses' }),
      ]);
      if (healthResponse.status !== 200 || coursesResponse.status !== 200) {
        throw new Error('本地服务返回了错误状态。');
      }
      setHealth(healthResponse.data);
      setCourses(coursesResponse.data);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '连接本地服务失败。');
    }
  }, []);

  useEffect(() => {
    void loadWorkspace();
  }, [loadWorkspace]);

  /** Creates a Course through the existing JSON bridge without changing its contract. */
  async function createCourse(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!title.trim()) return;

    setSaving(true);
    setError('');
    try {
      const response = await window.teachforge.request<Course>({
        method: 'POST',
        path: '/api/courses',
        body: { title, description },
      });
      if (response.status !== 201) {
        throw new Error('课程保存失败，请检查填写内容。');
      }
      setTitle('');
      setDescription('');
      await loadWorkspace();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '课程保存失败。');
    } finally {
      setSaving(false);
    }
  }

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <main className="min-h-screen bg-[#f0f2ed] p-2 text-stone-900">
        <div className="mx-auto flex min-h-[calc(100vh-1rem)] max-w-[1600px] flex-col lg:flex-row">
          <aside className="flex shrink-0 items-center justify-between gap-4 px-3 py-2 lg:w-[228px] lg:flex-col lg:items-stretch lg:justify-start lg:gap-8 lg:px-5 lg:py-5">
            <div className="flex shrink-0 items-center gap-3">
              <div aria-hidden="true" className="relative size-9 shrink-0">
                <span className="absolute left-1 top-1 h-6 w-5 border-2 border-emerald-900" />
                <span className="absolute bottom-1 right-1 h-6 w-5 border-2 border-emerald-700 bg-[#f0f2ed]" />
              </div>
              <div>
                <p className="text-sm font-semibold tracking-wide">TeachForge</p>
                <p className="text-xs text-stone-600">本地教学工作台</p>
              </div>
            </div>

            <nav aria-label="工作区" className="flex shrink-0 gap-1 lg:flex-col lg:gap-1">
            <button
              aria-current={activeTab === 'agent' ? 'page' : undefined}
              className={`whitespace-nowrap border-b-2 px-2 py-2 text-sm font-medium transition lg:border-b-0 lg:border-l-2 lg:px-3 lg:py-3 lg:text-left ${activeTab === 'agent' ? 'border-emerald-900 text-stone-900' : 'border-transparent text-stone-600 hover:text-stone-900'}`}
              onClick={() => setActiveTab('agent')}
              type="button"
            >
              Agent 对话
            </button>
            <button
              aria-current={activeTab === 'course' ? 'page' : undefined}
              className={`whitespace-nowrap border-b-2 px-2 py-2 text-sm font-medium transition lg:border-b-0 lg:border-l-2 lg:px-3 lg:py-3 lg:text-left ${activeTab === 'course' ? 'border-emerald-900 text-stone-900' : 'border-transparent text-stone-600 hover:text-stone-900'}`}
              onClick={() => setActiveTab('course')}
              type="button"
            >
              课程原型
            </button>
            </nav>
          </aside>

          <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:pr-2 lg:pb-2">
            <header className="flex h-12 shrink-0 items-center justify-between px-3 lg:px-5">
              <p className="text-sm font-medium text-stone-700">
                工作区 <span className="px-1 text-stone-400">/</span>{activeTab === 'agent' ? 'Agent 对话' : '课程原型'}
              </p>
              <div
                aria-live="polite"
                className="flex items-center gap-2 text-xs text-stone-600"
              >
                <span
                  className={`size-2 rounded-full ${health ? 'bg-emerald-700' : 'bg-amber-600'}`}
                />
                {health ? '本地服务已连接' : error ? '本地服务连接异常' : '正在连接服务'}
              </div>
            </header>

            <div className="min-h-0 flex-1 overflow-hidden rounded-2xl border border-[#e5e8e4] bg-white">
            <section
              aria-label="Agent 对话页面"
              className="h-full min-h-[32rem]"
              hidden={activeTab !== 'agent'}
            >
              <AgentChatPage runtime={runtime} />
            </section>

            <section
              aria-label="课程原型页面"
              className="h-full overflow-y-auto"
              hidden={activeTab !== 'course'}
            >
              <div className="mx-auto max-w-6xl py-8 md:py-10">
                <div className="grid gap-12 lg:grid-cols-[1.1fr_0.9fr]">
                  <div className="pt-2">
                    <p className="mb-4 text-sm font-medium text-stone-600">备课，从理解开始</p>
                    <h1 className="max-w-xl text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
                      让每一次备课，<br />
                      <span>都沉淀为积累。</span>
                    </h1>
                    <p className="mt-5 max-w-lg text-base leading-7 text-stone-600">
                      TeachForge 将课程、资料、知识研究与课堂演练汇集在一个本地工作台中。
                    </p>
                    <div className="mt-9 flex flex-wrap gap-3 text-xs text-stone-600">
                      <span className="rounded-full bg-white px-3 py-2 ring-1 ring-stone-200">Electron 桌面端</span>
                      <span className="rounded-full bg-white px-3 py-2 ring-1 ring-stone-200">NestJS 本地服务</span>
                      <span className="rounded-full bg-white px-3 py-2 ring-1 ring-stone-200">SQLite 数据存储</span>
                    </div>
                  </div>

                  <form
                    onSubmit={createCourse}
                    className="rounded-2xl border border-stone-200 bg-white p-6 md:p-7"
                  >
                    <div className="mb-6">
                      <p className="text-xs font-medium text-stone-500">第一步</p>
                      <h2 className="mt-2 text-xl font-semibold">创建一门课程</h2>
                      <p className="mt-1 text-sm text-stone-500">先建立课程空间，后续可以继续添加课次和资料。</p>
                    </div>

                    <label className="mb-4 block text-sm font-medium" htmlFor="course-title">
                      课程名称
                      <input
                        id="course-title"
                        className="mt-2 w-full rounded-lg border border-stone-300 bg-stone-50 px-3 py-2.5 text-sm outline-none transition focus:border-emerald-800 focus:ring-2 focus:ring-emerald-800/10"
                        maxLength={160}
                        onChange={(changeEvent) => setTitle(changeEvent.target.value)}
                        placeholder="例如：Redis 核心技术"
                        required
                        value={title}
                      />
                    </label>

                    <label className="mb-5 block text-sm font-medium" htmlFor="course-description">
                      课程说明 <span className="font-normal text-stone-400">（选填）</span>
                      <textarea
                        id="course-description"
                        className="mt-2 min-h-24 w-full resize-y rounded-lg border border-stone-300 bg-stone-50 px-3 py-2.5 text-sm outline-none transition focus:border-emerald-800 focus:ring-2 focus:ring-emerald-800/10"
                        maxLength={2000}
                        onChange={(changeEvent) => setDescription(changeEvent.target.value)}
                        placeholder="课程目标、学生基础或其他备课背景"
                        value={description}
                      />
                    </label>

                    {error && (
                      <p className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
                        {error}
                      </p>
                    )}

                    <button
                        className="flex w-full items-center justify-center rounded-lg bg-stone-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:opacity-60"
                      disabled={saving || !health}
                      type="submit"
                    >
                      {saving ? '正在保存…' : '创建课程'}
                    </button>
                  </form>
                </div>

                <section className="mt-10 border-t border-stone-200 pt-7">
                  <div className="mb-4 flex items-end justify-between">
                    <div>
                      <h2 className="text-lg font-semibold">我的课程</h2>
                      <p className="mt-1 text-sm text-stone-500">课程保存在本机，可在后续备课中持续扩展。</p>
                    </div>
                    <span className="text-xs text-stone-500">{courses.length} 门课程</span>
                  </div>

                  {courses.length === 0 ? (
                    <div className="rounded-xl border border-dashed border-stone-300 bg-white/60 px-5 py-8 text-center text-sm text-stone-500">
                      创建第一门课程后，它会显示在这里。
                    </div>
                  ) : (
                    <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
                      {courses.map((course) => (
                        <li className="rounded-xl border border-stone-200 bg-white p-4" key={course.id}>
                          <h3 className="font-semibold">{course.title}</h3>
                          <p className="mt-2 line-clamp-2 min-h-10 text-sm leading-5 text-stone-500">
                            {course.description || '尚未添加课程说明。'}
                          </p>
                          <p className="mt-4 text-xs text-stone-400">
                            创建于 {new Date(course.createdAt).toLocaleDateString('zh-CN')}
                          </p>
                        </li>
                      ))}
                    </ul>
                  )}
                </section>
              </div>
            </section>
            </div>
          </div>
        </div>
      </main>
    </AssistantRuntimeProvider>
  );
}
