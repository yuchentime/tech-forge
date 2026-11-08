import { useCallback, useEffect, useState } from 'react';
import { Eye, EyeClosed } from '@phosphor-icons/react';
import { hasDesktopBridge } from '../../types/desktop-bridge';

type ProviderId = 'deepseek' | 'custom';

/** Describes the local settings projection, including editable plaintext API Keys. */
interface LocalSettingsView {
  configDirectory: string;
  configFilePath: string;
  soulsFilePath: string;
  workspacePath: string;
  llm: {
    provider: ProviderId;
    deepseek: { modelId: string; apiKey: string; apiKeyConfigured: boolean };
    custom: {
      name: string;
      baseUrl: string;
      modelId: string;
      apiKey: string;
      apiKeyConfigured: boolean;
    };
  };
  souls: string;
}

/** Renders and persists the local model, workspace and style settings. */
export function SettingsPage() {
  const [settings, setSettings] = useState<LocalSettingsView | null>(null);
  const [provider, setProvider] = useState<ProviderId>('deepseek');
  const [deepseekApiKey, setDeepseekApiKey] = useState('');
  const [customApiKey, setCustomApiKey] = useState('');
  const [clearDeepseekApiKey, setClearDeepseekApiKey] = useState(false);
  const [clearCustomApiKey, setClearCustomApiKey] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  /** Loads the saved local configuration when the settings view is opened. */
  const loadSettings = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    if (!hasDesktopBridge()) {
      setLoadError('请通过 TeachForge 桌面应用访问本机设置。');
      setIsLoading(false);
      return;
    }

    try {
      const response = await window.teachforge.request<unknown>({
        method: 'GET',
        path: '/api/settings',
      });
      if (response.status !== 200 || !isLocalSettingsView(response.data)) {
        throw new Error(readErrorMessage(response.data, '读取设置失败，请重试。'));
      }
      setSettings(response.data);
      setProvider(response.data.llm.provider);
      setDeepseekApiKey(response.data.llm.deepseek.apiKey);
      setCustomApiKey(response.data.llm.custom.apiKey);
    } catch (error) {
      setLoadError(
        error instanceof Error ? error.message : '读取设置失败，请重试。',
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
      (settings.llm.deepseek.apiKeyConfigured || Boolean(deepseekApiKey.trim()));
    if (provider === 'deepseek' && !hasDeepseekKey) {
      setSaveError('请填写 DeepSeek API Key 后再保存。');
      setStatusMessage(null);
      return;
    }
    setIsSaving(true);
    setSaveError(null);
    setStatusMessage(null);

    try {
      const response = await window.teachforge.request<unknown>({
        method: 'PUT',
        path: '/api/settings',
        body: {
          llm: {
            provider,
            deepseek: {
              modelId: settings.llm.deepseek.modelId,
              ...(!clearDeepseekApiKey && deepseekApiKey.trim()
                ? { apiKey: deepseekApiKey }
                : {}),
              ...(clearDeepseekApiKey ? { clearApiKey: true } : {}),
            },
            custom: {
              name: settings.llm.custom.name,
              baseUrl: settings.llm.custom.baseUrl,
              modelId: settings.llm.custom.modelId,
              ...(!clearCustomApiKey && customApiKey.trim()
                ? { apiKey: customApiKey }
                : {}),
              ...(clearCustomApiKey ? { clearApiKey: true } : {}),
            },
          },
          workspacePath: settings.workspacePath,
          souls: settings.souls,
        },
      });
      if (response.status !== 200 || !isLocalSettingsView(response.data)) {
        throw new Error(readErrorMessage(response.data, '保存设置失败，请重试。'));
      }
      setSettings(response.data);
      setProvider(response.data.llm.provider);
      setDeepseekApiKey(response.data.llm.deepseek.apiKey);
      setCustomApiKey(response.data.llm.custom.apiKey);
      setClearDeepseekApiKey(false);
      setClearCustomApiKey(false);
      setStatusMessage('设置已保存。');
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : '保存设置失败，请重试。',
      );
    } finally {
      setIsSaving(false);
    }
  }, [
    clearCustomApiKey,
    clearDeepseekApiKey,
    customApiKey,
    deepseekApiKey,
    provider,
    settings,
  ]);

  /** Updates one DeepSeek field while preserving the rest of the form. */
  const updateDeepseek = useCallback(
    (field: 'modelId', value: string) => {
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
    },
    [],
  );

  /** Updates one custom provider field without replacing other settings. */
  const updateCustom = useCallback(
    (field: 'name' | 'baseUrl' | 'modelId', value: string) => {
      setSettings((current) =>
        current
          ? {
              ...current,
              llm: {
                ...current.llm,
                custom: { ...current.llm.custom, [field]: value },
              },
            }
          : current,
      );
    },
    [],
  );

  /** Updates the Markdown content stored in the local SOULS.md file. */
  const updateSouls = useCallback((value: string) => {
    setSettings((current) => (current ? { ...current, souls: value } : current));
  }, []);

  /** Updates the local workspace path without changing any active session. */
  const updateWorkspacePath = useCallback((value: string) => {
    setSettings((current) =>
      current ? { ...current, workspacePath: value } : current,
    );
  }, []);

  return (
    <section className="flex min-h-0 min-w-0 flex-1 flex-col bg-stone-50/50">
      <header className="flex shrink-0 items-center justify-between gap-4 border-b border-stone-200 bg-white px-5 py-4 md:px-8">
        <div>
          <h1 className="text-xl font-semibold tracking-tight text-stone-900">设置</h1>
          <p className="mt-1 text-sm text-stone-500">管理模型连接、工作空间与回答风格。</p>
        </div>
        <button
          className="rounded-lg bg-stone-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-stone-700 disabled:cursor-wait disabled:opacity-50"
          disabled={!settings || isLoading || isSaving}
          form="local-settings-form"
          type="submit"
        >
          {isSaving ? '正在保存…' : '保存设置'}
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 md:px-8 md:py-8">
        <div className="mx-auto w-full max-w-4xl space-y-6 pb-8">
          {isLoading ? (
            <p className="py-12 text-center text-sm text-stone-500" role="status">
              正在读取本机设置…
            </p>
          ) : loadError ? (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-4 text-sm text-rose-800" role="alert">
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
              <section className="rounded-xl border border-stone-200 bg-white p-5 md:p-6">
                <div className="mb-5">
                  <h2 className="text-base font-semibold text-stone-900">模型配置</h2>
                  <p className="mt-1 text-sm leading-6 text-stone-500">
                    选择当前对话使用的模型服务。配置保存在这台设备上。
                  </p>
                </div>

                <fieldset className="mb-6">
                  <legend className="mb-2 block text-sm font-medium text-stone-800">
                    模型供应商
                  </legend>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <ProviderChoice
                      checked={provider === 'deepseek'}
                      description="连接 DeepSeek 官方服务"
                      disabled={isSaving}
                      label="DeepSeek"
                      onChange={() => setProvider('deepseek')}
                    />
                    <ProviderChoice
                      checked={provider === 'custom'}
                      description="使用 OpenAI 兼容接口"
                      disabled={isSaving}
                      label="自定义"
                      onChange={() => setProvider('custom')}
                    />
                  </div>
                </fieldset>

                {provider === 'deepseek' ? (
                  <div className="space-y-4">
                    <TextField
                      autoComplete="off"
                      disabled={isSaving}
                      label="模型 ID"
                      onChange={(value) => updateDeepseek('modelId', value)}
                      required
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
                ) : (
                  <div className="space-y-4">
                    <TextField
                      autoComplete="organization"
                      disabled={isSaving}
                      label="厂商名称"
                      onChange={(value) => updateCustom('name', value)}
                      required
                      value={settings.llm.custom.name}
                    />
                    <TextField
                      autoComplete="url"
                      disabled={isSaving}
                      helpText="填写服务的 API 根地址，例如 https://api.example.com/v1。"
                      label="Base URL"
                      onChange={(value) => updateCustom('baseUrl', value)}
                      placeholder="https://"
                      required
                      type="url"
                      value={settings.llm.custom.baseUrl}
                    />
                    <TextField
                      autoComplete="off"
                      disabled={isSaving}
                      label="模型 ID"
                      onChange={(value) => updateCustom('modelId', value)}
                      required
                      value={settings.llm.custom.modelId}
                    />
                    <SecretField
                      configured={settings.llm.custom.apiKeyConfigured}
                      disabled={isSaving}
                      label="API Key（可选）"
                      onClearChange={setClearCustomApiKey}
                      onKeyChange={setCustomApiKey}
                      clearRequested={clearCustomApiKey}
                      value={customApiKey}
                    />
                  </div>
                )}
              </section>

              <section className="rounded-xl border border-stone-200 bg-white p-5 md:p-6">
                <div className="mb-5">
                  <h2 className="text-base font-semibold text-stone-900">工作空间</h2>
                  <p className="mt-1 max-w-3xl text-sm leading-6 text-stone-500">
                    Agent 默认在此目录创建和修改文件；默认目录与本机配置分开存放。读取仍可使用其他来源，写入目录外的文件需要在本轮请求中明确给出目标绝对路径。
                  </p>
                </div>
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <div className="min-w-0 flex-1">
                    <TextField
                      autoComplete="off"
                      disabled={isSaving}
                      id="setting-workspace-path"
                      helpText="请输入绝对路径。新会话会使用此目录作为默认文件工作空间。"
                      label="工作空间路径"
                      onChange={updateWorkspacePath}
                      placeholder={getDefaultWorkspacePath(settings.configDirectory)}
                      required
                      value={settings.workspacePath}
                    />
                  </div>
                  <button
                    className="min-h-10 shrink-0 rounded-lg border border-stone-300 px-3 text-sm font-medium text-stone-700 transition hover:bg-stone-50 disabled:cursor-wait disabled:opacity-50"
                    disabled={
                      isSaving ||
                      settings.workspacePath ===
                        getDefaultWorkspacePath(settings.configDirectory)
                    }
                    onClick={() =>
                      updateWorkspacePath(
                        getDefaultWorkspacePath(settings.configDirectory),
                      )
                    }
                    type="button"
                  >
                    恢复默认目录
                  </button>
                </div>
              </section>

              <section className="rounded-xl border border-stone-200 bg-white p-5 md:p-6">
                <div className="mb-4">
                  <h2 className="text-base font-semibold text-stone-900">风格偏好</h2>
                  <p className="mt-1 max-w-3xl text-sm leading-6 text-stone-500">
                    写下希望助手长期遵循的表达方式或备课习惯。内容会作为系统提示词的补充，用于之后新建的模型会话。
                  </p>
                </div>
                <textarea
                  aria-label="风格偏好内容"
                  className="min-h-52 w-full resize-y rounded-lg border border-stone-300 bg-white px-3 py-3 text-sm leading-6 text-stone-800 outline-none transition placeholder:text-stone-400 focus:border-emerald-800 focus:ring-2 focus:ring-emerald-800/10 disabled:bg-stone-50"
                  disabled={isSaving}
                  id="souls-content"
                  onChange={(event) => updateSouls(event.target.value)}
                  placeholder={'例如：\n- 先用贴近课堂的例子解释新概念\n- 重点内容分层说明，避免一次给出过长答案'}
                  value={settings.souls}
                />
              </section>

              <div aria-live="polite" className="min-h-6 text-sm" role="status">
                {saveError && <p className="text-rose-700">{saveError}</p>}
                {statusMessage && <p className="text-emerald-800">{statusMessage}</p>}
              </div>
            </form>
          ) : null}
        </div>
      </div>
    </section>
  );
}

/** Renders a labelled provider radio choice with a quiet selected state. */
function ProviderChoice({
  checked,
  description,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  description: string;
  disabled: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <label
      className={`flex cursor-pointer items-start gap-3 rounded-lg border px-4 py-3 transition ${
        checked
          ? 'border-stone-500 bg-stone-100'
          : 'border-stone-200 bg-white hover:border-stone-400'
      } ${disabled ? 'cursor-not-allowed opacity-60' : ''}`}
    >
      <input
        checked={checked}
        className="mt-1 accent-emerald-800"
        disabled={disabled}
        name="model-provider"
        onChange={onChange}
        type="radio"
      />
      <span>
        <span className="block text-sm font-medium text-stone-900">{label}</span>
        <span className="mt-0.5 block text-xs leading-5 text-stone-500">{description}</span>
      </span>
    </label>
  );
}

/** Renders a consistent labelled text field with an optional helper sentence. */
function TextField({
  autoComplete,
  disabled,
  id,
  helpText,
  label,
  onChange,
  placeholder,
  required = false,
  type = 'text',
  value,
}: {
  autoComplete: string;
  disabled: boolean;
  id?: string;
  helpText?: string;
  label: string;
  onChange: (value: string) => void;
  placeholder?: string;
  required?: boolean;
  type?: 'text' | 'url';
  value: string;
}) {
  const fieldId = id ?? `setting-${label.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}`;
  const helpId = helpText ? `${fieldId}-help` : undefined;
  return (
    <div>
      <label className="mb-1.5 block text-sm font-medium text-stone-800" htmlFor={fieldId}>
        {label}
      </label>
      <input
        aria-describedby={helpId}
        autoComplete={autoComplete}
        className="w-full rounded-lg border border-stone-300 bg-white px-3 py-2.5 text-sm text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-emerald-800 focus:ring-2 focus:ring-emerald-800/10 disabled:bg-stone-50"
        disabled={disabled}
        id={fieldId}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        required={required}
        type={type}
        value={value}
      />
      {helpText && (
        <p className="mt-1.5 text-xs leading-5 text-stone-500" id={helpId}>
          {helpText}
        </p>
      )}
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
      <label className="mb-1.5 block text-sm font-medium text-stone-800" htmlFor={`key-${label}`}>
        {label}
      </label>
      <div className="relative">
        <input
          autoComplete="off"
          autoCapitalize="none"
          className="w-full rounded-lg border border-stone-300 bg-white py-2.5 pl-3 pr-11 text-sm text-stone-900 outline-none transition placeholder:text-stone-400 focus:border-emerald-800 focus:ring-2 focus:ring-emerald-800/10 disabled:bg-stone-50"
          disabled={disabled || clearRequested}
          id={`key-${label}`}
          onChange={(event) => onKeyChange(event.target.value)}
          placeholder={configured ? '已保存，留空可保持不变' : '输入本机 API Key'}
          spellCheck={false}
          type={isRevealed ? 'text' : 'password'}
          value={value}
        />
        <button
          aria-label={isRevealed ? '隐藏 API Key' : '显示 API Key'}
          aria-pressed={isRevealed}
          className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-stone-500 transition hover:text-stone-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-emerald-800 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled || clearRequested}
          onClick={() => setIsRevealed((revealed) => !revealed)}
          title={isRevealed ? '隐藏 API Key' : '显示 API Key'}
          type="button"
        >
          {isRevealed ? (
            <EyeClosed aria-hidden="true" size={20} />
          ) : (
            <Eye aria-hidden="true" size={20} />
          )}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-stone-500">
        <span>
          {clearRequested
            ? '保存后移除已保存密钥'
            : configured
              ? '已保存密钥默认隐藏，可通过右侧眼睛图标显示并编辑'
              : '密钥保存在本机配置文件中'}
        </span>
        {configured && (
          <button
            className="font-medium text-stone-700 underline underline-offset-2 disabled:opacity-50"
            disabled={disabled}
            onClick={() => {
              onClearChange(!clearRequested);
            }}
            type="button"
          >
            {clearRequested ? '取消清除' : '清除已保存密钥'}
          </button>
        )}
      </div>
    </div>
  );
}

/** Checks the local settings shape, including API Keys, before using a response. */
function isLocalSettingsView(value: unknown): value is LocalSettingsView {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as Partial<LocalSettingsView>;
  return (
    typeof candidate.configFilePath === 'string' &&
    typeof candidate.soulsFilePath === 'string' &&
    typeof candidate.configDirectory === 'string' &&
    typeof candidate.workspacePath === 'string' &&
    typeof candidate.souls === 'string' &&
    typeof candidate.llm === 'object' &&
    candidate.llm !== null &&
    (candidate.llm.provider === 'deepseek' || candidate.llm.provider === 'custom') &&
    typeof candidate.llm.deepseek?.modelId === 'string' &&
    typeof candidate.llm.deepseek.apiKey === 'string' &&
    typeof candidate.llm.deepseek.apiKeyConfigured === 'boolean' &&
    typeof candidate.llm.custom?.name === 'string' &&
    typeof candidate.llm.custom.baseUrl === 'string' &&
    typeof candidate.llm.custom.modelId === 'string' &&
    typeof candidate.llm.custom.apiKey === 'string' &&
    typeof candidate.llm.custom.apiKeyConfigured === 'boolean'
  );
}

/** Builds the fixed default Agent output directory using the host path style. */
function getDefaultWorkspacePath(configDirectory: string): string {
  const separator = configDirectory.includes('\\') ? '\\' : '/';
  return `${configDirectory.replace(/[\\/]+$/, '')}${separator}workspace`;
}

/** Extracts a safe human-readable message from a backend error envelope. */
function readErrorMessage(value: unknown, fallback: string): string {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return fallback;
  }
  const message = (value as { message?: unknown }).message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message) && message.every((part) => typeof part === 'string')) {
    return message.join(' ');
  }
  return fallback;
}
