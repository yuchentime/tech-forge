import { CircleNotch } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';

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
          <span className="inline-flex h-10 items-center rounded-full bg-emerald-50 px-4 text-xs font-semibold tracking-wide text-emerald-800">
            费曼提问演练
          </span>
          <h2 className="mt-4 text-xl font-semibold text-stone-900">
            让一名学生检验你的理解
          </h2>
          <p className="mx-auto mt-2 max-w-lg text-sm leading-6 text-stone-500">
            AI 会扮演一名学生，根据当前对话的学习内容向你提问。
            你用自己的话回答，它会决定继续追问还是换一个知识点。
          </p>
        </div>

        <div className="mt-7 rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
          <label className="block text-sm font-medium text-stone-800" htmlFor="rehearsal-persona">
            学生画像（可选）
          </label>
          <textarea
            className="mt-2 min-h-24 w-full resize-y rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm leading-6 text-stone-900 outline-none transition focus:border-emerald-700 focus:ring-2 focus:ring-emerald-800/10"
            id="rehearsal-persona"
            maxLength={1000}
            onBlur={() => {
              if (draft !== persona) onSavePersona(draft);
            }}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="例如：初二学生，喜欢追问“为什么”，对抽象定义不敏感，需要具体例子；会质疑老师回答中跳过的步骤。"
            value={draft}
          />
          <p className="mt-1.5 text-xs text-stone-500">
            留空则使用默认的好奇学生画像。画像只影响提问视角，不改变演练规则。
          </p>
          {personaError && (
            <p className="mt-1.5 text-xs text-rose-700" role="alert">
              {personaError}
            </p>
          )}

          {error && (
            <div className="mt-3 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700" role="alert">
              {error}
            </div>
          )}

          <button
            className="mt-4 inline-flex h-12 w-full items-center justify-center gap-2 rounded-xl bg-emerald-800 px-5 text-sm font-semibold text-white transition hover:bg-emerald-900 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={Boolean(disabledReason) || isStarting}
            onClick={() => onStart(draft)}
            type="button"
          >
            {isStarting && <CircleNotch aria-hidden className="h-4 w-4 animate-spin" />}
            {isStarting ? '正在准备演练…' : '开始演练'}
          </button>
          {disabledReason && (
            <p className="mt-2 text-center text-xs leading-5 text-stone-500" role="status">
              {disabledReason}
            </p>
          )}
        </div>

        <p className="mt-3 text-center text-xs text-stone-400">
          演练会读取当前对话的学习内容；不会修改对话模式消息。
        </p>
      </div>
    </div>
  );
}
