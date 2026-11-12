import { Injectable } from "@nestjs/common";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SettingsService } from "../settings/settings.service";

/** Reads the generated catalog as untrusted text and supplies its revision to Chat; it owns no DB state. */
@Injectable()
export class KnowledgeDirectoryService {
  constructor(private readonly settings: SettingsService) {}

  async loadForAgent(): Promise<{ text: string; revision: string }> {
    let index = "";
    try {
      index = await readFile(
        join(this.settings.getKnowledgeDirectory(), "index.md"),
        "utf8",
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const revision = createHash("sha256").update(index).digest("hex");
    return { text: index, revision };
  }

  /** Formats the durable Pi entry; catalog text never becomes a system instruction. */
  renderLoadedContext(snapshot: { text: string; revision: string }): string {
    if (!snapshot.text || snapshot.text.trim())
      return "\n\n## 资料库目录\n目录为空";
    return `\n\n## 资料库目录\n${snapshot.text}\n\n<agent_state source="knowledge-index" status="loaded">\n资料库目录已加载到本轮上下文。不要再次读取 index.md；根据其中的 path 仅读取回答所需的原文。\n</agent_state>`;
  }
}
