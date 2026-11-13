import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { SettingsService } from "../settings/settings.service";

/** Reads the generated catalog as untrusted text and supplies its revision to Chat; it owns no DB state. */
@Injectable()
export class KnowledgeDirectoryService {
  constructor(private readonly settings: SettingsService) {}

  async loadForAgent(): Promise<{ text: string; revision: string }> {
    let index = "";
    try {
      index = await readFile(this.settings.getKnowledgeCatalogPath(), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const revision = createHash("sha256").update(index).digest("hex");
    return { text: index, revision };
  }

  /**
   * Formats the durable Pi entry; catalog text never becomes a system instruction.
   *
   * Catalog entries store `path` relative to the knowledge directory, but the session's working
   * directory named in the system prompt is a different, sibling directory. `<root_path>` travels
   * with every rendered catalog, including the empty one, so the model can join a path instead of
   * guessing an absolute one and finding the file by trial and error.
   */
  renderLoadedContext(snapshot: { text: string; revision: string }): string {
    const rootPath = escapeXmlText(this.settings.getKnowledgeDirectory());
    const header = `\n\n## 资料库目录\n\n<root_path>${rootPath}</root_path>`;
    if (!snapshot.text.trim())
      return `${header}\n\n目录为空`;
    return `${header}\n\n${snapshot.text}\n\n<agent_state source="knowledge-index" status="loaded">\n资料库目录已加载到本轮上下文。不要再次读取 index.md；path 是相对 root_path 的路径，拼出完整路径后仅读取回答所需的原文。\n</agent_state>`;
  }
}

/** Escapes a path placed between XML tags so `&` or `<` stays data instead of markup. */
function escapeXmlText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
