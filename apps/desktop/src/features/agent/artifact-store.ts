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
    this.listeners.forEach((listener) => listener());
  }
}

export const artifactTabsStore = new ArtifactTabsStore();
