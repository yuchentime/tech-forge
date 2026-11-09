import { hasDesktopBridge } from '../../types/desktop-bridge';

/** Identifies one generated file in the footer and the sidebar. */
export interface GeneratedFileRef {
  id: string;
  fileName: string;
  /** Preview family: markdown, mermaid, json, jsonl or text. */
  contentFormat: string;
  /** True when the stored path no longer exists on disk. */
  missing: boolean;
  /** True when the user asked for a destination outside the session workspace. */
  external: boolean;
}

/** Key of the built-in tab that lists every generated file of the conversation. */
export const ALL_FILES_TAB_ID = 'all';

/** Groups the files produced per assistant message for the history footer. */
class ArtifactHistoryStore {
  private readonly listeners = new Set<() => void>();
  private snapshot: Readonly<Record<string, readonly GeneratedFileRef[]>> = {};

  /** Subscribes the footers to history changes. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Returns the per-message file map. */
  getSnapshot = (): Readonly<Record<string, readonly GeneratedFileRef[]>> => this.snapshot;

  /** Replaces the map from one history page; messages without files are omitted. */
  setFromHistory(
    messages: readonly { id: string; role: string; generatedFiles?: readonly GeneratedFileRef[] }[],
  ): void {
    const next: Record<string, readonly GeneratedFileRef[]> = {};
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      if (!message.generatedFiles || message.generatedFiles.length === 0) continue;
      next[message.id] = message.generatedFiles;
    }
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }

  /** Merges one older page without dropping the entries already shown. */
  mergeFromHistory(
    messages: readonly { id: string; role: string; generatedFiles?: readonly GeneratedFileRef[] }[],
  ): void {
    const next: Record<string, readonly GeneratedFileRef[]> = { ...this.snapshot };
    for (const message of messages) {
      if (message.role !== 'assistant') continue;
      if (!message.generatedFiles || message.generatedFiles.length === 0) continue;
      next[message.id] = message.generatedFiles;
    }
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }

  /** Drops every entry when the visible conversation changes. */
  clear(): void {
    if (Object.keys(this.snapshot).length === 0) return;
    this.snapshot = {};
    this.listeners.forEach((listener) => listener());
  }

  /** Drops one removed artifact from the per-message footers, emptying messages that lose them all. */
  remove(artifactId: string): void {
    let changed = false;
    const next: Record<string, readonly GeneratedFileRef[]> = {};
    for (const [messageId, files] of Object.entries(this.snapshot)) {
      const kept = files.filter((file) => file.id !== artifactId);
      if (kept.length === files.length) {
        next[messageId] = files;
        continue;
      }
      changed = true;
      if (kept.length > 0) next[messageId] = kept;
    }
    if (!changed) return;
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
}

export const artifactHistoryStore = new ArtifactHistoryStore();

/** Describes the sidebar's open tabs and which one is showing. */
export interface ArtifactTabsSnapshot {
  /** Open file tabs; the `all` tab is implicit and never stored here. */
  tabs: readonly GeneratedFileRef[];
  /** `all` or one artifact id. */
  activeId: string;
  /** True while at least one file tab is open. */
  visible: boolean;
}

/** Owns the read-only artifact sidebar's tab state for the active conversation. */
class ArtifactTabsStore {
  private readonly listeners = new Set<() => void>();
  private readonly byConversationId = new Map<string, ArtifactTabsSnapshot>();
  private activeConversationId: string | null = null;
  private snapshot: ArtifactTabsSnapshot = {
    tabs: [],
    activeId: ALL_FILES_TAB_ID,
    visible: false,
  };

  /** Subscribes the sidebar and the footer buttons to tab changes. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Returns the current tab state. */
  getSnapshot = (): ArtifactTabsSnapshot => this.snapshot;

  /** Switches tab state without allowing tabs from one conversation to appear in another. */
  selectConversation(conversationId: string | null): void {
    if (this.activeConversationId === conversationId) return;
    this.saveActive();
    this.activeConversationId = conversationId;
    this.snapshot =
      (conversationId ? this.byConversationId.get(conversationId) : undefined) ?? {
        tabs: [],
        activeId: ALL_FILES_TAB_ID,
        visible: false,
      };
    this.listeners.forEach((listener) => listener());
  }

  /** Opens the file in a tab, focusing it when it is already open. */
  open(file: GeneratedFileRef): void {
    const exists = this.snapshot.tabs.some((tab) => tab.id === file.id);
    const tabs = exists
      ? this.snapshot.tabs.map((tab) => (tab.id === file.id ? file : tab))
      : [...this.snapshot.tabs, file];
    this.update({ tabs, activeId: file.id, visible: true });
  }

  /** Focuses the `all` tab without touching the open file tabs. */
  showAll(): void {
    this.update({ ...this.snapshot, activeId: ALL_FILES_TAB_ID, visible: true });
  }

  /** Opens the list tab, or collapses the panel when it is already showing. */
  toggleAll(): void {
    if (this.snapshot.visible) {
      this.hide();
      return;
    }
    this.update({ ...this.snapshot, activeId: ALL_FILES_TAB_ID, visible: true });
  }

  /** Collapses the panel without closing tabs, so reopening keeps the previous selection. */
  hide(): void {
    if (!this.snapshot.visible) return;
    this.update({ ...this.snapshot, visible: false });
  }

  /** Focuses one open tab. */
  activate(id: string): void {
    if (id !== ALL_FILES_TAB_ID && !this.snapshot.tabs.some((tab) => tab.id === id)) return;
    this.update({ ...this.snapshot, activeId: id });
  }

  /** Closes one tab and focuses `all` when the closed tab was active. */
  close(id: string): void {
    const tabs = this.snapshot.tabs.filter((tab) => tab.id !== id);
    const activeId =
      this.snapshot.activeId === id ? ALL_FILES_TAB_ID : this.snapshot.activeId;
    this.update({ tabs, activeId, visible: tabs.length > 0 });
  }

  /**
   * Drops a tab whose artifact row was deleted, keeping the panel open.
   *
   * Unlike `close` this never collapses the sidebar: deleting a file from the list must leave the
   * list in place, so the panel only changes which tab it shows.
   */
  remove(id: string): void {
    if (!this.snapshot.tabs.some((tab) => tab.id === id)) return;
    const tabs = this.snapshot.tabs.filter((tab) => tab.id !== id);
    const activeId =
      this.snapshot.activeId === id
        ? tabs[tabs.length - 1]?.id ?? ALL_FILES_TAB_ID
        : this.snapshot.activeId;
    this.update({ ...this.snapshot, tabs, activeId, visible: true });
  }

  /** Collapses the sidebar and forgets every tab, used when switching conversations. */
  reset(): void {
    this.update({ tabs: [], activeId: ALL_FILES_TAB_ID, visible: false });
  }

  /** Refreshes the stored metadata of already-open tabs after a list refetch. */
  syncAll(files: readonly GeneratedFileRef[]): void {
    const byId = new Map(files.map((file) => [file.id, file]));
    const tabs = this.snapshot.tabs.map((tab) => byId.get(tab.id) ?? tab);
    this.update({ ...this.snapshot, tabs });
  }

  /** Publishes one snapshot and notifies subscribers. */
  private update(next: ArtifactTabsSnapshot): void {
    this.snapshot = next;
    this.saveActive();
    this.listeners.forEach((listener) => listener());
  }

  /** Persists the visible namespace only when it belongs to a remote conversation. */
  private saveActive(): void {
    if (this.activeConversationId) this.byConversationId.set(this.activeConversationId, this.snapshot);
  }
}

export const artifactTabsStore = new ArtifactTabsStore();

/** Describes the generated-file list of the active conversation. */
export interface ArtifactListSnapshot {
  /** Conversation the rows belong to, so a switched conversation never shows stale files. */
  conversationId: string | null;
  status: 'idle' | 'loading' | 'ready' | 'error';
  files: readonly GeneratedFileRef[];
  error: string | null;
}

/**
 * Owns the generated-file list of the active conversation.
 *
 * The conversation header (entry with a file count) and the sidebar (file rows) read the same
 * snapshot, so a conversation is fetched once no matter how many surfaces consume it.
 */
class ArtifactListStore {
  private readonly listeners = new Set<() => void>();
  private requestVersion = 0;
  /**
   * Artifacts deleted from the sidebar, so a refetch whose query raced the delete cannot put the
   * row back. Scoped to one conversation and only ever holds ids the server confirmed deleted;
   * a later write to the same path registers a new id and is unaffected.
   */
  private readonly removedIds = new Set<string>();
  private snapshot: ArtifactListSnapshot = {
    conversationId: null,
    status: 'idle',
    files: [],
    error: null,
  };

  /** Subscribes the header and the sidebar to list changes. */
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  /** Returns the current list snapshot. */
  getSnapshot = (): ArtifactListSnapshot => this.snapshot;

  /** Loads one conversation's files; a late response never overwrites a newer selection. */
  async load(conversationId: string | null): Promise<void> {
    const version = ++this.requestVersion;
    if (this.snapshot.conversationId !== conversationId) this.removedIds.clear();
    if (!conversationId || !hasDesktopBridge()) {
      this.update({ conversationId, status: 'idle', files: [], error: null });
      return;
    }
    const keptFiles =
      this.snapshot.conversationId === conversationId ? this.snapshot.files : [];
    this.update({ conversationId, status: 'loading', files: keptFiles, error: null });
    try {
      const response = await window.teachforge.request<GeneratedFileRef[]>({
        method: 'GET',
        path: `/api/conversations/${encodeURIComponent(conversationId)}/artifacts`,
      });
      if (version !== this.requestVersion) return;
      if (response.status !== 200) {
        this.update({ conversationId, status: 'error', files: [], error: '文件列表加载失败。' });
        return;
      }
      const files = response.data.filter((file) => !this.removedIds.has(file.id));
      this.update({ conversationId, status: 'ready', files, error: null });
      // Open tabs keep their identity across refreshes, so their missing flags stay current.
      artifactTabsStore.syncAll(files);
    } catch {
      if (version !== this.requestVersion) return;
      this.update({ conversationId, status: 'error', files: [], error: '文件列表加载失败。' });
    }
  }

  /**
   * Drops one removed artifact from the list so the sidebar and the header badge agree.
   *
   * The id is remembered for the conversation: a list refetch started before the delete committed
   * would otherwise show the row again until the next refresh.
   */
  remove(artifactId: string): void {
    this.removedIds.add(artifactId);
    if (!this.snapshot.files.some((file) => file.id === artifactId)) return;
    this.update({
      ...this.snapshot,
      files: this.snapshot.files.filter((file) => file.id !== artifactId),
    });
  }

  /** Publishes one snapshot and notifies subscribers. */
  private update(next: ArtifactListSnapshot): void {
    this.snapshot = next;
    this.listeners.forEach((listener) => listener());
  }
}

export const artifactListStore = new ArtifactListStore();
