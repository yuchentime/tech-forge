import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  OnModuleInit,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  lstat,
  mkdir,
  readFile,
  rename,
  unlink,
  writeFile,
} from 'node:fs/promises';
import {
  CUSTOM_PROVIDER_ID,
  DEEPSEEK_MODEL_ID,
  DEEPSEEK_PROVIDER_ID,
} from '../llm/adapters/llm-adapter';
import type { SaveSettingsInput } from './settings.dto';

type ProviderId = 'deepseek' | 'custom';

/** Holds the full local Provider configuration, including secrets kept on disk. */
export interface StoredLlmSettings {
  provider: ProviderId;
  deepseek: { modelId: string; apiKey: string };
  custom: { name: string; baseUrl: string; modelId: string; apiKey: string };
}

/** Holds all file-backed settings while keeping workspace outside LLM config. */
export interface StoredSettings extends StoredLlmSettings {
  workspacePath: string;
}

/** Describes settings returned through the authenticated local desktop API. */
export interface LocalSettingsView {
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

const CONFIG_FILE_NAME = 'config.toml';
const SOULS_FILE_NAME = 'SOULS.md';

/** Conversation ids are UUIDv4; the session directory path is built from one. */
const CONVERSATION_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LLM_SETTING_KEYS = new Set([
  'llm.provider',
  'llm.deepseek.model_id',
  'llm.deepseek.api_key',
  'llm.custom.name',
  'llm.custom.base_url',
  'llm.custom.model_id',
  'llm.custom.api_key',
]);

/** Owns the per-user TOML configuration and Markdown style preference files. */
@Injectable()
export class SettingsService implements OnModuleInit {
  /**
   * Per-user configuration root; `TEACHFORGE_CONFIG_DIR` relocates it (portable installs and
   * isolated integration tests), otherwise it is `<home>/.tech-forge`.
   */
  private readonly configDirectory = process.env.TEACHFORGE_CONFIG_DIR ?? join(homedir(), '.tech-forge');
  private readonly configPath = join(this.configDirectory, CONFIG_FILE_NAME);
  private readonly soulsPath = join(this.configDirectory, SOULS_FILE_NAME);
  /** Separates Agent-created files from the app-owned config and style files. */
  private readonly defaultWorkspacePath = join(this.configDirectory, 'workspace');
  /**
   * Knowledge-library copies live beside the config, never inside the workspace.
   *
   * Keeping them out of the Agent's working directory is what stops a default `grep` from walking the
   * uploaded originals; `workspace-file-tools` additionally guards the subtree so a model-chosen path
   * cannot read it either.
   */
  private readonly knowledgeDirectory = join(this.configDirectory, 'knowledge');
  /** Per-conversation local files (attachments and future run data), beside config and knowledge. */
  private readonly sessionsDirectory = join(this.configDirectory, 'sessions');
  /**
   * Agent long-term memory owned by the pi-memory extension.
   *
   * Kept beside config/knowledge instead of the extension's default `~/.pi/agent/memory`, so all
   * TeachForge state lives under one root and `TEACHFORGE_CONFIG_DIR` relocates it too.
   */
  private readonly memoryDirectory = join(this.configDirectory, 'memory');
  private initializationPromise?: Promise<void>;
  private saveQueue: Promise<void> = Promise.resolve();

  /** Creates the user configuration directory and default files on backend start. */
  async onModuleInit(): Promise<void> {
    await this.ensureInitialized();
  }

  /** Returns local settings, including API Keys, to the authenticated desktop UI. */
  async getSettings(): Promise<LocalSettingsView> {
    await this.ensureInitialized();
    const saved = await this.readSettings();
    const souls = await this.readSouls();
    return {
      configDirectory: this.configDirectory,
      configFilePath: this.configPath,
      soulsFilePath: this.soulsPath,
      workspacePath: saved.workspacePath,
      llm: {
        provider: saved.provider,
        deepseek: {
          modelId: saved.deepseek.modelId,
          apiKey: saved.deepseek.apiKey,
          apiKeyConfigured: Boolean(saved.deepseek.apiKey),
        },
        custom: {
          name: saved.custom.name,
          baseUrl: saved.custom.baseUrl,
          modelId: saved.custom.modelId,
          apiKey: saved.custom.apiKey,
          apiKeyConfigured: Boolean(saved.custom.apiKey),
        },
      },
      souls,
    };
  }

  /** Reads the current Provider configuration for one new Pi session. */
  async getLlmSettings(): Promise<StoredLlmSettings> {
    await this.ensureInitialized();
    return this.readLlmSettings();
  }

  /** Returns the app-owned knowledge library root, deliberately outside the Agent workspace. */
  getKnowledgeDirectory(): string {
    return this.knowledgeDirectory;
  }

  /** Returns the root for per-conversation session files (attachments and future run data). */
  getSessionsDirectory(): string {
    return this.sessionsDirectory;
  }

  /**
   * Returns the pi-memory storage root.
   *
   * The Agent layer passes it to the extension as `PI_MEMORY_DIR`; the extension creates the
   * directory itself on first use.
   */
  getMemoryDirectory(): string {
    return this.memoryDirectory;
  }

  /**
   * Returns one conversation's session directory.
   *
   * The id is validated before it becomes a path segment: callers pass request data, and a session
   * directory must never be able to point outside `<configDir>/sessions`.
   */
  getSessionDirectory(conversationId: string): string {
    if (!CONVERSATION_ID_PATTERN.test(conversationId)) {
      throw new Error('conversation id must be a UUID before building a session path.');
    }
    return join(this.sessionsDirectory, conversationId);
  }

  /** Returns the saved Agent output root without exposing it through LLM settings. */
  async getWorkspacePath(): Promise<string> {
    await this.ensureInitialized();
    return (await this.readSettings()).workspacePath;
  }

  /**
   * Returns app-owned file paths only so Agent tools can deny aliases to them.
   * SettingsService remains the sole reader and writer of both files. The knowledge library is not
   * listed here: it is a guarded directory (`getKnowledgeDirectory`), readable only when the current
   * user request names it.
   */
  async getManagedFilePaths(): Promise<readonly string[]> {
    await this.ensureInitialized();
    return [this.configPath, this.soulsPath];
  }

  /** Reads the current user-authored style text for a new Pi session. */
  async getStylePreference(): Promise<string> {
    await this.ensureInitialized();
    return this.readSouls();
  }

  /** Merges settings, preserves omitted keys, and atomically replaces local files. */
  async saveSettings(input: SaveSettingsInput): Promise<LocalSettingsView> {
    let releaseSave!: () => void;
    const previousSave = this.saveQueue;
    this.saveQueue = new Promise<void>((resolve) => {
      releaseSave = resolve;
    });
    await previousSave;

    try {
      await this.ensureInitialized();
      const current = await this.readSettings();
      const next: StoredSettings = {
        workspacePath: normalizeWorkspacePath(
          input.workspacePath,
          this.defaultWorkspacePath,
          this.configDirectory,
        ),
        provider: input.llm.provider,
        deepseek: {
          modelId: input.llm.deepseek.modelId.trim() || DEEPSEEK_MODEL_ID,
          apiKey: resolveApiKey(
            current.deepseek.apiKey,
            input.llm.deepseek.apiKey,
            input.llm.deepseek.clearApiKey,
          ),
        },
        custom: {
          name: input.llm.custom.name.trim(),
          baseUrl: input.llm.custom.baseUrl.trim(),
          modelId: input.llm.custom.modelId.trim(),
          apiKey: resolveApiKey(
            current.custom.apiKey,
            input.llm.custom.apiKey,
            input.llm.custom.clearApiKey,
          ),
        },
      };

      await this.replaceFile(this.configPath, serializeSettings(next));
      await this.replaceFile(this.soulsPath, input.souls);
      return this.getSettings();
    } catch (error) {
      if (error instanceof BadRequestException) throw error;
      throw new InternalServerErrorException(
        '无法保存本机设置文件，请检查 .tech-forge 目录权限和 config.toml 格式。',
      );
    } finally {
      releaseSave();
    }
  }

  /** Initializes app-owned files and the default workspace once per backend process. */
  private ensureInitialized(): Promise<void> {
    this.initializationPromise ??= this.initializeFiles();
    return this.initializationPromise;
  }

  /** Creates owner-only local files without overwriting an existing configuration. */
  private async initializeFiles(): Promise<void> {
    await mkdir(this.configDirectory, { recursive: true, mode: 0o700 });
    try {
      await readFile(this.configPath, 'utf8');
    } catch (error) {
      if (!isMissingFile(error)) throw error;
      const defaults = createDefaultSettings(this.defaultWorkspacePath);
      try {
        await writeFile(this.configPath, serializeSettings(defaults), {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });
      } catch (writeError) {
        if (!isAlreadyExists(writeError)) throw writeError;
      }
    }

    try {
      await writeFile(this.soulsPath, '', {
        encoding: 'utf8',
        flag: 'wx',
        mode: 0o600,
      });
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }

    // Do not let a pre-created symlink redirect the default Agent output root.
    await mkdir(this.defaultWorkspacePath, { recursive: true, mode: 0o700 });
    const workspaceInfo = await lstat(this.defaultWorkspacePath);
    if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory()) {
      throw new InternalServerErrorException(
        '默认 Agent 工作空间必须是普通目录。',
      );
    }

    await this.readLlmSettings();
  }

  /** Reads and validates all supported fields from the application TOML file. */
  private async readSettings(): Promise<StoredSettings> {
    let rawConfig: string;
    try {
      rawConfig = await readFile(this.configPath, 'utf8');
    } catch {
      throw new InternalServerErrorException(
        '无法读取本机 config.toml，请检查文件权限。',
      );
    }

    try {
      return parseSettings(
        rawConfig,
        this.defaultWorkspacePath,
        this.configDirectory,
      );
    } catch {
      throw new InternalServerErrorException(
        '本机 config.toml 格式无效；请修复或移除该文件后重启 TeachForge。',
      );
    }
  }

  /** Projects the model fields without exposing unrelated local settings. */
  private async readLlmSettings(): Promise<StoredLlmSettings> {
    let rawConfig: string;
    try {
      rawConfig = await readFile(this.configPath, 'utf8');
    } catch {
      throw new InternalServerErrorException(
        '无法读取本机 config.toml，请检查文件权限。',
      );
    }

    try {
      return parseLlmSettings(rawConfig);
    } catch {
      throw new InternalServerErrorException(
        '本机 config.toml 格式无效；请修复或移除该文件后重启 TeachForge。',
      );
    }
  }

  /** Reads the local style preference without logging or transforming its content. */
  private async readSouls(): Promise<string> {
    try {
      return await readFile(this.soulsPath, 'utf8');
    } catch (error) {
      if (isMissingFile(error)) return '';
      throw new InternalServerErrorException(
        '无法读取本机 SOULS.md，请检查文件权限。',
      );
    }
  }

  /** Replaces one user file through a same-directory temporary file and rename. */
  private async replaceFile(filePath: string, contents: string): Promise<void> {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, contents, {
        encoding: 'utf8',
        mode: 0o600,
      });
      await rename(temporaryPath, filePath);
    } catch (error) {
      await unlink(temporaryPath).catch(() => undefined);
      throw error;
    }
  }
}

/** Returns a fresh default configuration for a first application launch. */
function createDefaultSettings(defaultWorkspacePath: string): StoredSettings {
  return {
    workspacePath: resolve(defaultWorkspacePath),
    provider: 'deepseek',
    deepseek: { modelId: DEEPSEEK_MODEL_ID, apiKey: '' },
    custom: { name: '', baseUrl: '', modelId: '', apiKey: '' },
  };
}

/** Parses app-owned setting fields and defaults legacy workspace paths. */
function parseSettings(
  contents: string,
  defaultWorkspacePath: string,
  configDirectory: string,
): StoredSettings {
  const values = parseTomlSettings(contents, isSupportedSettingKey);
  return {
    ...parseLlmSettingsValues(values),
    workspacePath: normalizeWorkspacePath(
      values.get('workspace.path') ?? defaultWorkspacePath,
      defaultWorkspacePath,
      configDirectory,
    ),
  };
}

/** Parses only Provider fields so workspace settings cannot affect LLM reads. */
function parseLlmSettings(contents: string): StoredLlmSettings {
  return parseLlmSettingsValues(parseTomlSettings(contents, isLlmSettingKey));
}

/** Reads supported TOML strings while ignoring fields outside the projection. */
function parseTomlSettings(
  contents: string,
  supportsKey: (key: string) => boolean,
): Map<string, string> {
  const values = new Map<string, string>();
  let section = '';
  const lines = contents.split(/\r?\n/);

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const line = lines[lineIndex].trim();
    if (!line || line.startsWith('#')) continue;

    const sectionMatch = /^\[([A-Za-z0-9_.-]+)\]$/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1];
      continue;
    }

    const assignmentMatch = /^([A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (!assignmentMatch) throw new Error(`Invalid TOML line ${lineIndex + 1}.`);
    const [, key, rawValue] = assignmentMatch;
    const fullKey = `${section}.${key}`;
    if (!supportsKey(fullKey)) continue;

    const stringMatch = /^((?:"(?:\\.|[^"\\])*"))\s*(?:#.*)?$/.exec(rawValue);
    if (!stringMatch) throw new Error(`Invalid TOML string on line ${lineIndex + 1}.`);
    values.set(fullKey, parseTomlString(stringMatch[1]));
  }

  return values;
}

/** Builds the model config shared by the LLM-only and full settings views. */
function parseLlmSettingsValues(values: Map<string, string>): StoredLlmSettings {
  const provider = values.get('llm.provider') ?? 'deepseek';
  if (provider !== 'deepseek' && provider !== 'custom') {
    throw new Error('Unknown LLM provider.');
  }

  return {
    provider,
    deepseek: {
      modelId: values.get('llm.deepseek.model_id') || DEEPSEEK_MODEL_ID,
      apiKey: values.get('llm.deepseek.api_key') ?? '',
    },
    custom: {
      name: values.get('llm.custom.name') ?? '',
      baseUrl: values.get('llm.custom.base_url') ?? '',
      modelId: values.get('llm.custom.model_id') ?? '',
      apiKey: values.get('llm.custom.api_key') ?? '',
    },
  };
}

/** Identifies known configuration fields so unrelated TOML keys are ignored. */
function isSupportedSettingKey(key: string): boolean {
  return isLlmSettingKey(key) || key === 'workspace.path';
}

/** Identifies Provider-only fields consumed by the model runtime. */
function isLlmSettingKey(key: string): boolean {
  return LLM_SETTING_KEYS.has(key);
}

/** Decodes one TOML basic string without evaluating or logging its content. */
function parseTomlString(rawValue: string): string {
  let result = '';
  for (let index = 1; index < rawValue.length - 1; index += 1) {
    const character = rawValue[index];
    if (character !== '\\') {
      result += character;
      continue;
    }

    const escape = rawValue[++index];
    const simpleEscapes: Record<string, string> = {
      b: '\b',
      t: '\t',
      n: '\n',
      f: '\f',
      r: '\r',
      '"': '"',
      '\\': '\\',
    };
    if (escape in simpleEscapes) {
      result += simpleEscapes[escape];
      continue;
    }
    if (escape === 'u' || escape === 'U') {
      const digits = escape === 'u' ? 4 : 8;
      const codePointText = rawValue.slice(index + 1, index + 1 + digits);
      if (!new RegExp(`^[0-9A-Fa-f]{${digits}}$`).test(codePointText)) {
        throw new Error('Invalid TOML Unicode escape.');
      }
      const codePoint = Number.parseInt(codePointText, 16);
      if (codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        throw new Error('Invalid TOML Unicode code point.');
      }
      result += String.fromCodePoint(codePoint);
      index += digits;
      continue;
    }
    throw new Error('Invalid TOML escape.');
  }
  return result;
}

/** Serializes supported local settings into a stable TOML document. */
function serializeSettings(settings: StoredSettings): string {
  return [
    '# TeachForge local settings. API keys in this file are private.',
    '[llm]',
    `provider = ${toTomlString(settings.provider)}`,
    '',
    '[llm.deepseek]',
    `model_id = ${toTomlString(settings.deepseek.modelId)}`,
    `api_key = ${toTomlString(settings.deepseek.apiKey)}`,
    '',
    '[llm.custom]',
    `name = ${toTomlString(settings.custom.name)}`,
    `base_url = ${toTomlString(settings.custom.baseUrl)}`,
    `model_id = ${toTomlString(settings.custom.modelId)}`,
    `api_key = ${toTomlString(settings.custom.apiKey)}`,
    '',
    '[workspace]',
    `path = ${toTomlString(settings.workspacePath)}`,
    '',
  ].join('\n');
}

/** Normalizes the output root, migrates the old default, and keeps app config outside it. */
function normalizeWorkspacePath(
  workspacePath: string,
  defaultWorkspacePath: string,
  configDirectory: string,
): string {
  const candidate = workspacePath.trim() || defaultWorkspacePath;
  if (candidate.length > 4096 || !isAbsolute(candidate)) {
    throw new BadRequestException('工作空间路径必须是绝对路径。');
  }
  const normalized = resolve(candidate);
  const normalizedConfigDirectory = resolve(configDirectory);

  // The prior default was .tech-forge itself; migrate only that exact legacy value.
  if (areSamePath(normalized, normalizedConfigDirectory)) {
    return resolve(defaultWorkspacePath);
  }
  if (isPathWithin(normalized, normalizedConfigDirectory)) {
    throw new BadRequestException(
      '工作空间不能是 .tech-forge 配置目录本身或其上级目录。',
    );
  }
  return normalized;
}

/** Checks whether a candidate path is the root itself or one of its descendants. */
function isPathWithin(root: string, candidate: string): boolean {
  const pathFromRoot = relative(root, candidate);
  return (
    pathFromRoot === '' ||
    (pathFromRoot !== '..' &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot))
  );
}

/** Compares normalized paths with Windows' case-insensitive path semantics. */
function areSamePath(firstPath: string, secondPath: string): boolean {
  const first = resolve(firstPath);
  const second = resolve(secondPath);
  return process.platform === 'win32'
    ? first.toLowerCase() === second.toLowerCase()
    : first === second;
}

/** Escapes arbitrary user text into a valid TOML basic string. */
function toTomlString(value: string): string {
  let escaped = '"';
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (character === '"') escaped += '\\"';
    else if (character === '\\') escaped += '\\\\';
    else if (codePoint === 0x08) escaped += '\\b';
    else if (codePoint === 0x09) escaped += '\\t';
    else if (codePoint === 0x0a) escaped += '\\n';
    else if (codePoint === 0x0c) escaped += '\\f';
    else if (codePoint === 0x0d) escaped += '\\r';
    else if (codePoint < 0x20 || codePoint === 0x7f) {
      escaped += `\\u${codePoint.toString(16).padStart(4, '0')}`;
    } else escaped += character;
  }
  return `${escaped}"`;
}

/** Preserves a saved API Key unless the user submits a replacement or clear action. */
function resolveApiKey(
  existingKey: string,
  submittedKey: string | undefined,
  clearApiKey: boolean | undefined,
): string {
  if (submittedKey?.trim()) return submittedKey.trim();
  if (clearApiKey) return '';
  return existingKey;
}

/** Distinguishes a missing file from other filesystem errors. */
function isMissingFile(error: unknown): boolean {
  return hasErrorCode(error, 'ENOENT');
}

/** Distinguishes an existing file during first-run creation. */
function isAlreadyExists(error: unknown): boolean {
  return hasErrorCode(error, 'EEXIST');
}

/** Reads a Node filesystem error code without exposing the original error text. */
function hasErrorCode(error: unknown, code: string): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === code
  );
}
