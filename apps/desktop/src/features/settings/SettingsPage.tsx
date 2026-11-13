import { Eye, EyeClosed } from "@phosphor-icons/react";
import { useCallback, useEffect, useState } from "react";
import { readBackendErrorMessage } from "../../api/backend-error";
import { PageHeader } from "../../components/PageHeader";
import { showToast } from "../agent/toast";
import { hasDesktopBridge } from "../../types/desktop-bridge";

/** Describes the local settings projection, including the editable plaintext API Key. */
interface LocalSettingsView {
  configDirectory: string;
  configFilePath: string;
  preferenceFilePath: string;
  identifyFilePath: string;
  workspacePath: string;
  llm: {
    deepseek: { modelId: string; apiKey: string; apiKeyConfigured: boolean };
  };
  preference: string;
  identify: string;
}

/** Renders and persists the local model, workspace and style settings. */
export function SettingsPage() {
  const [settings, setSettings] = useState<LocalSettingsView | null>(null);
  const [deepseekApiKey, setDeepseekApiKey] = useState("");
  const [clearDeepseekApiKey, setClearDeepseekApiKey] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  /** Loads the saved local configuration when the settings view is opened. */
  const loadSettings = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    if (!hasDesktopBridge()) {
      setLoadError("请通过 TeachForge 桌面应用访问本机设置。");
      setIsLoading(false);
      return;
    }

    try {
      const response = await window.teachforge.request<unknown>({
        method: "GET",
        path: "/api/settings",
      });
      if (response.status !== 200 || !isLocalSettingsView(response.data)) {
        throw new Error(
          readBackendErrorMessage(response.data, "读取设置失败，请重试。"),
        );
      }
      setSettings(response.data);
      setDeepseekApiKey(response.data.llm.deepseek.apiKey);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : "读取设置失败，请重试。",
      );
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  /** Saves local settings and refreshes the plaintext keys from the response. */
  const saveSettings = useCallback(async () => {
    if (!settings || !hasDesktopBridge()) return;
    const hasDeepseekKey =
      !clearDeepseekApiKey &&
      (settings.llm.deepseek.apiKeyConfigured ||
        Boolean(deepseekApiKey.trim()));
    if (!hasDeepseekKey) {
      setSaveError("请填写 DeepSeek API Key 后再保存。");
      return;
    }
    setIsSaving(true);
    setSaveError(null);

    try {
      const response = await window.teachforge.request<unknown>({
        method: "PUT",
        path: "/api/settings",
        body: {
          llm: {
            deepseek: {
              modelId: settings.llm.deepseek.modelId,
              ...(!clearDeepseekApiKey && deepseekApiKey.trim()
                ? { apiKey: deepseekApiKey }
                : {}),
              ...(clearDeepseekApiKey ? { clearApiKey: true } : {}),
            },
          },
          preference: settings.preference,
          identify: settings.identify,
        },
      });
      if (response.status !== 200 || !isLocalSettingsView(response.data)) {
        throw new Error(
          readBackendErrorMessage(response.data, "保存设置失败，请重试。"),
        );
      }
      setSettings(response.data);
      setDeepseekApiKey(response.data.llm.deepseek.apiKey);
      setClearDeepseekApiKey(false);
      showToast("设置已保存。");
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "保存设置失败，请重试。",
      );
    } finally {
      setIsSaving(false);
    }
  }, [clearDeepseekApiKey, deepseekApiKey, settings]);

  /** Updates one DeepSeek field while preserving the rest of the form. */
  const updateDeepseek = useCallback((field: "modelId", value: string) => {
    setSettings((current) =>
      current
        ? {
            ...current,
            llm: {
              ...current.llm,
              deepseek: { ...current.llm.deepseek, [field]: value },
            },
          }
        : current,
    );
  }, []);

  /** Updates the Markdown content stored in the local PREFERENCE.md file. */
  const updatePreference = useCallback((value: string) => {
    setSettings((current) =>
      current ? { ...current, preference: value } : current,
    );
  }, []);

  /** Updates the Markdown content stored in the local IDENTIFY.md file. */
  const updateIdentify = useCallback((value: string) => {
    setSettings((current) =>
      current ? { ...current, identify: value } : current,
    );
  }, []);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-ink-50/50">
      <PageHeader className="justify-between">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-ink-900">
            设置
          </h1>
        </div>
        <button
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-ink-700 disabled:cursor-wait disabled:opacity-50"
          disabled={!settings || isLoading || isSaving}
          form="local-settings-form"
          type="submit"
        >
          {isSaving ? "正在保存…" : "保存设置"}
        </button>
      </PageHeader>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 md:px-8 md:py-8">
        <div className="mx-auto w-full max-w-4xl space-y-6 pb-8">
          {isLoading ? (
            <p
              className="py-12 text-center text-sm text-ink-500"
              role="status"
            >
              正在读取本机设置…
            </p>
          ) : loadError ? (
            <div
              className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-4 text-sm text-rose-800"
              role="alert"
            >
              <p>{loadError}</p>
              <button
                className="mt-3 font-medium underline underline-offset-2"
                onClick={() => void loadSettings()}
                type="button"
              >
                重试
              </button>
            </div>
          ) : settings ? (
            <form
              className="space-y-6"
              id="local-settings-form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveSettings();
              }}
            >
              <section className="rounded-xl border border-ink-200 bg-white p-5 md:p-6">
                <div className="mb-5">
                  <h2 className="text-base font-semibold text-ink-900">
                    模型配置
                  </h2>
                  <p className="mt-1 text-sm leading-6 text-ink-500">
                    当前对话使用 DeepSeek 官方服务。配置保存在这台设备上。
                  </p>
                </div>

                <div className="space-y-4">
                  <TextField
                    autoComplete="off"
                    disabled={isSaving}
                    label="模型 ID"
                    onChange={(value) => updateDeepseek("modelId", value)}
                    value={settings.llm.deepseek.modelId}
                  />
                  <SecretField
                    configured={settings.llm.deepseek.apiKeyConfigured}
                    disabled={isSaving}
                    label="API Key"
                    onClearChange={setClearDeepseekApiKey}
                    onKeyChange={setDeepseekApiKey}
                    clearRequested={clearDeepseekApiKey}
                    value={deepseekApiKey}
                  />
                </div>
              </section>

              <section className="rounded-xl border border-ink-200 bg-white p-5 md:p-6">
                <div className="mb-4">
                  <h2 className="text-base font-semibold text-ink-900">
                    身份设定
                  </h2>
                  <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-500">
                    写下你的身份、目标和学习场景。助手会按你的背景调整讲解方式。
                  </p>
                </div>
                <textarea
                  aria-label="身份设定内容"
                  className="min-h-52 w-full resize-y rounded-lg border border-ink-300 bg-white px-3 py-3 text-sm leading-6 text-ink-800 outline-none transition placeholder:text-ink-400 focus:border-brand-600 focus:ring-2 focus:ring-brand-600/10 disabled:bg-ink-50"
                  disabled={isSaving}
                  id="identify-content"
                  onChange={(event) => updateIdentify(event.target.value)}
                  placeholder={
                    "例如：\n- 我是一名已有 2 年工作经验的程序员\n- 希望深入学习语言和框架的底层原理，提升原理层面的理解\n- 目标是在大厂面试中拿到更好的机会"
                  }
                  value={settings.identify}
                />
              </section>

              <section className="rounded-xl border border-ink-200 bg-white p-5 md:p-6">
                <div className="mb-4">
                  <h2 className="text-base font-semibold text-ink-900">
                    风格偏好
                  </h2>
                  <p className="mt-1 max-w-3xl text-sm leading-6 text-ink-500">
                    写下你希望助手长期遵循的表达方式或备课习惯。
                  </p>
                </div>
                <textarea
                  aria-label="风格偏好内容"
                  className="min-h-52 w-full resize-y rounded-lg border border-ink-300 bg-white px-3 py-3 text-sm leading-6 text-ink-800 outline-none transition placeholder:text-ink-400 focus:border-brand-600 focus:ring-2 focus:ring-brand-600/10 disabled:bg-ink-50"
                  disabled={isSaving}
                  id="preference-content"
                  onChange={(event) => updatePreference(event.target.value)}
                  placeholder={
                    "例如：\n- 先用贴近课堂的例子解释新概念\n- 重点内容分层说明，避免一次给出过长答案"
                  }
                  value={settings.preference}
                />
              </section>

              <div aria-live="polite" className="min-h-6 text-sm" role="status">
                {saveError && <p className="text-rose-700">{saveError}</p>}
              </div>
            </form>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** Renders the labelled model ID field. */
function TextField({
  autoComplete,
  disabled,
  label,
  onChange,
  value,
}: {
  autoComplete: string;
  disabled: boolean;
  label: string;
  onChange: (value: string) => void;
  value: string;
}) {
  const fieldId = `setting-${label.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;
  return (
    <div>
      <label
        className="mb-1.5 block text-sm font-medium text-ink-800"
        htmlFor={fieldId}
      >
        {label}
      </label>
      <input
        autoComplete={autoComplete}
        className="w-full rounded-lg border border-ink-300 bg-white px-3 py-2.5 text-sm text-ink-900 outline-none transition placeholder:text-ink-400 focus:border-brand-600 focus:ring-2 focus:ring-brand-600/10 disabled:bg-ink-50"
        disabled={disabled}
        id={fieldId}
        onChange={(event) => onChange(event.target.value)}
        required
        type="text"
        value={value}
      />
    </div>
  );
}

/** Keeps API Keys masked by default while supporting reveal, replacement and explicit removal. */
function SecretField({
  clearRequested,
  configured,
  disabled,
  label,
  onClearChange,
  onKeyChange,
  value,
}: {
  clearRequested: boolean;
  configured: boolean;
  disabled: boolean;
  label: string;
  onClearChange: (value: boolean) => void;
  onKeyChange: (value: string) => void;
  value: string;
}) {
  const [isRevealed, setIsRevealed] = useState(false);

  return (
    <div>
      <label
        className="mb-1.5 block text-sm font-medium text-ink-800"
        htmlFor={`key-${label}`}
      >
        {label}
      </label>
      <div className="relative">
        <input
          autoComplete="off"
          autoCapitalize="none"
          className="w-full rounded-lg border border-ink-300 bg-white py-2.5 pl-3 pr-11 text-sm text-ink-900 outline-none transition placeholder:text-ink-400 focus:border-brand-600 focus:ring-2 focus:ring-brand-600/10 disabled:bg-ink-50"
          disabled={disabled || clearRequested}
          id={`key-${label}`}
          onChange={(event) => onKeyChange(event.target.value)}
          placeholder={
            configured ? "已保存，留空可保持不变" : "输入本机 API Key"
          }
          spellCheck={false}
          type={isRevealed ? "text" : "password"}
          value={value}
        />
        <button
          aria-label={isRevealed ? "隐藏 API Key" : "显示 API Key"}
          aria-pressed={isRevealed}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-ink-500 transition hover:text-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-brand-600 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled || clearRequested}
          onClick={() => setIsRevealed((revealed) => !revealed)}
          title={isRevealed ? "隐藏 API Key" : "显示 API Key"}
          type="button"
        >
          {isRevealed ? (
            <EyeClosed aria-hidden="true" size={20} />
          ) : (
            <Eye aria-hidden="true" size={20} />
          )}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-ink-500">
        <span>
          {clearRequested
            ? "保存后移除已保存密钥"
            : configured
              ? "已保存密钥默认隐藏，可通过右侧眼睛图标显示并编辑"
              : "密钥保存在本机配置文件中"}
        </span>
        {configured && (
          <button
            className="font-medium text-ink-700 underline underline-offset-2 disabled:opacity-50"
            disabled={disabled}
            onClick={() => {
              onClearChange(!clearRequested);
            }}
            type="button"
          >
            {clearRequested ? "取消清除" : "清除已保存密钥"}
          </button>
        )}
      </div>
    </div>
  );
}

/** Checks the local settings shape, including API Keys, before using a response. */
function isLocalSettingsView(value: unknown): value is LocalSettingsView {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<LocalSettingsView>;
  return (
    typeof candidate.configFilePath === "string" &&
    typeof candidate.preferenceFilePath === "string" &&
    typeof candidate.identifyFilePath === "string" &&
    typeof candidate.configDirectory === "string" &&
    typeof candidate.workspacePath === "string" &&
    typeof candidate.preference === "string" &&
    typeof candidate.identify === "string" &&
    typeof candidate.llm === "object" &&
    candidate.llm !== null &&
    typeof candidate.llm.deepseek?.modelId === "string" &&
    typeof candidate.llm.deepseek.apiKey === "string" &&
    typeof candidate.llm.deepseek.apiKeyConfigured === "boolean"
  );
}
