import { useCallback, useEffect, useState, type FormEvent } from 'react';

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

export default function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);

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
    <main className="min-h-screen px-8 py-7 text-stone-900 md:px-12 md:py-10">
      <div className="mx-auto max-w-6xl">
        <header className="flex items-center justify-between border-b border-stone-200 pb-5">
          <div className="flex items-center gap-3">
            <div className="grid size-10 place-items-center rounded-xl bg-emerald-900 text-sm font-semibold text-white">TF</div>
            <div>
              <p className="text-sm font-semibold tracking-wide">TeachForge</p>
              <p className="text-xs text-stone-500">本地教学工作台</p>
            </div>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-1.5 text-xs text-stone-600">
            <span className={`size-2 rounded-full ${health ? 'bg-emerald-500' : 'bg-amber-500'}`} />
            {health ? '本地服务已连接' : '正在连接服务'}
          </div>
        </header>

        <section className="grid gap-12 py-12 lg:grid-cols-[1.1fr_0.9fr] lg:py-16">
          <div className="pt-2">
            <p className="mb-4 text-xs font-semibold uppercase tracking-[0.2em] text-emerald-800">备课，从理解开始</p>
            <h1 className="max-w-xl text-4xl font-semibold leading-tight tracking-tight md:text-5xl">
              让每一次备课，<br />
              <span className="text-emerald-900">都沉淀为积累。</span>
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

          <form onSubmit={createCourse} className="rounded-2xl border border-stone-200 bg-white p-6 shadow-sm md:p-7">
            <div className="mb-6">
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-stone-500">第一步</p>
              <h2 className="mt-2 text-xl font-semibold">创建一门课程</h2>
              <p className="mt-1 text-sm text-stone-500">先建立课程空间，后续可以继续添加课次和资料。</p>
            </div>

            <label className="mb-4 block text-sm font-medium" htmlFor="course-title">
              课程名称
              <input
                id="course-title"
                className="mt-2 w-full rounded-lg border border-stone-300 bg-stone-50 px-3 py-2.5 text-sm outline-none transition focus:border-emerald-800 focus:ring-2 focus:ring-emerald-800/10"
                maxLength={160}
                onChange={(event) => setTitle(event.target.value)}
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
                onChange={(event) => setDescription(event.target.value)}
                placeholder="课程目标、学生基础或其他备课背景"
                value={description}
              />
            </label>

            {error && <p className="mb-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">{error}</p>}

            <button
              className="flex w-full items-center justify-center rounded-lg bg-emerald-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-emerald-800 disabled:cursor-not-allowed disabled:opacity-60"
              disabled={saving || !health}
              type="submit"
            >
              {saving ? '正在保存…' : '创建课程'}
            </button>
          </form>
        </section>

        <section className="border-t border-stone-200 pt-7">
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
                  <p className="mt-4 text-xs text-stone-400">创建于 {new Date(course.createdAt).toLocaleDateString('zh-CN')}</p>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
