import { CircleNotch, GraduationCap, Sparkle } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

/** What the drill will do, shown as small chips so the value reads before starting. */
const DRILL_VALUE_CHIPS = ['检验理解', '发现盲点', '练表达'];

/** Optional student profile input and the primary start action. */
export function RehearsalStart({
  persona,
  personaError,
  isStarting,
  error,
  disabledReason,
  onStart,
  onSavePersona,
}: {
  persona: string;
  personaError: string | null;
  isStarting: boolean;
  error: string | null;
  disabledReason: string | null;
  onStart: (persona: string) => void;
  onSavePersona: (persona: string) => void;
}) {
  const [draft, setDraft] = useState(persona);

  useEffect(() => {
    setDraft(persona);
  }, [persona]);

  return (
    <div className="flex h-full min-h-0 items-center justify-center overflow-y-auto py-8">
      <div className="w-full max-w-2xl">
        <div className="text-center">
          <span className="inline-flex h-10 items-center gap-2 rounded-full bg-brand-50 px-4 text-xs font-semibold tracking-wide text-brand-700 ring-1 ring-brand-200/70">
            <GraduationCap aria-hidden className="h-4 w-4" />
            费曼提问演练
          </span>
          <h2 className="mt-4 text-2xl font-semibold tracking-tight text-ink-900">
            让一名学生检验你的理解
          </h2>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-ink-500">
            AI 会扮演一名好奇的学生，根据当前对话的学习内容向你提问。
            你用自己的话回答，它会决定继续追问还是换一个知识点。
          </p>
          <ul className="mt-4 flex flex-wrap items-center justify-center gap-2">
            {DRILL_VALUE_CHIPS.map((chip) => (
              <li
                className="inline-flex items-center gap-1.5 rounded-full bg-white/70 px-3 py-1 text-xs text-ink-600 ring-1 ring-ink-200/70"
                key={chip}
              >
                <Sparkle aria-hidden className="h-3 w-3 text-honey-500" weight="fill" />
                {chip}
              </li>
            ))}
          </ul>
        </div>

        <div className="mt-7 rounded-3xl border border-ink-200/80 bg-white/80 p-5 shadow-card backdrop-blur">
          <label className="block text-sm font-medium text-ink-800" htmlFor="rehearsal-persona">
            学生画像（可选）
          </label>
          <textarea
            className="mt-2 min-h-24 w-full resize-y rounded-2xl border border-ink-200 bg-white px-3 py-2 text-sm leading-6 text-ink-900 outline-none transition placeholder:text-ink-400 focus:border-brand-400 focus:ring-4 focus:ring-brand-200/50"
            id="rehearsal-persona"
            maxLength={1000}
            onBlur={() => {
              if (draft !== persona) onSavePersona(draft);
            }}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="例如：初二学生，喜欢追问“为什么”，对抽象定义不敏感，需要具体例子；会质疑老师回答中跳过的步骤。"
            value={draft}
          />
          <p className="mt-1.5 text-xs text-ink-500">
            留空则使用默认的好奇学生画像。画像只影响提问视角，不改变演练规则。
          </p>
          {personaError && (
            <p className="mt-1.5 text-xs text-rose-700" role="alert">
              {personaError}
            </p>
          )}

          {error && (
            <div className="mt-3 rounded-xl bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
              {error}
            </div>
          )}

          <button
            className="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-2xl bg-brand-700 px-5 text-sm font-semibold text-white shadow-sm transition hover:bg-brand-800 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={Boolean(disabledReason) || isStarting}
            onClick={() => onStart(draft)}
            type="button"
          >
            {isStarting ? (
              <CircleNotch aria-hidden className="h-4 w-4 animate-spin" />
            ) : (
              <GraduationCap aria-hidden className="h-4 w-4" />
            )}
            {isStarting ? '正在准备演练…' : '开始演练'}
          </button>
          {disabledReason && (
            <p className="mt-2 text-center text-xs leading-5 text-ink-500" role="status">
              {disabledReason}
            </p>
          )}
        </div>

        <p className="mt-3 text-center text-xs text-ink-400">
          演练会读取当前对话的学习内容；不会修改对话模式消息。
        </p>
      </div>
    </div>
  );
}
