/**
 * 从当前用户请求中推导一次性外部写入授权。
 * 文本解析只负责缩小授权范围，不执行文件系统操作。
 */
import { basename, isAbsolute, resolve } from 'node:path';
import { isPathWithin } from './workspace-file-policy';

/** 外部写入授权只指向一个具体文件，或一个明确目录及其后代。 */
export type ExternalWriteGrant =
  | { kind: 'directory'; targetPath: string }
  | { kind: 'file'; targetPath: string };

/** 仅从本轮用户原文中提取唯一、明确的绝对写入目标。 */
export function deriveExternalWriteGrant(
  currentUserRequest: string,
  workspaceRoot: string,
): ExternalWriteGrant | undefined {
  const candidates = extractAbsolutePromptPaths(currentUserRequest);
  if (candidates.length !== 1) return undefined;

  const candidate = candidates[0];
  const lineStart = currentUserRequest.lastIndexOf('\n', candidate.start - 1) + 1;
  const nextNewline = currentUserRequest.indexOf('\n', candidate.end);
  const lineEnd = nextNewline < 0 ? currentUserRequest.length : nextNewline;
  const line = currentUserRequest.slice(lineStart, lineEnd);
  if (!HAS_WRITE_INTENT.test(line) || hasNegatedWriteIntent(line)) return undefined;
  if (!candidate.quoted && !hasClearUnquotedPathBoundary(currentUserRequest, candidate.end, lineEnd)) {
    return undefined;
  }
  if (!isAbsolute(candidate.path)) return undefined;

  const targetPath = resolve(candidate.path);
  if (isPathWithin(workspaceRoot, targetPath)) return undefined;
  const kind = classifyExternalTarget(candidate.path, line);
  if (!kind) return undefined;
  return {
    kind,
    targetPath,
  };
}

/** 提取带引号的含空格路径和不带引号的平台绝对路径。 */
function extractAbsolutePromptPaths(
  prompt: string,
): Array<{ path: string; start: number; end: number; quoted: boolean }> {
  const quotedRanges: Array<{ start: number; end: number }> = [];
  const candidates: Array<{
    path: string;
    start: number;
    end: number;
    quoted: boolean;
  }> = [];
  const quotedPattern = /(["'`])((?:[A-Za-z]:[\\/]|\\\\|\/)[^"'`\r\n]+?)\1/g;
  for (const match of prompt.matchAll(quotedPattern)) {
    const path = match[2].trim();
    const start = match.index! + 1;
    const end = start + match[2].length;
    quotedRanges.push({ start: match.index!, end: match.index! + match[0].length });
    candidates.push({ path, start, end, quoted: true });
  }

  const unquotedPattern = /(?:[A-Za-z]:[\\/]|\\\\|\/)[^\s"'`<>|,;，；。！？!?]+/g;
  for (const match of prompt.matchAll(unquotedPattern)) {
    const start = match.index!;
    const end = start + match[0].length;
    if (quotedRanges.some((range) => start >= range.start && end <= range.end)) {
      continue;
    }
    candidates.push({ path: match[0], start, end, quoted: false });
  }

  return candidates;
}

/** 拒绝可能只是含空格路径前缀的未加引号目标。 */
function hasClearUnquotedPathBoundary(
  prompt: string,
  pathEnd: number,
  lineEnd: number,
): boolean {
  const trailingText = prompt.slice(pathEnd, lineEnd).trim();
  return trailingText === '' || /^[.!?。！？,，;；]+$/u.test(trailingText);
}

/** 判断路径所在的同一行是否明确要求写入或修改文件。 */
const HAS_WRITE_INTENT =
  /\b(?:write|save|create|generate|export|store|put)\b|写入|写到|保存|创建|生成|导出|输出|存放|放到|新建/iu;

/** 识别并排除明确禁止写入的表达。 */
function hasNegatedWriteIntent(line: string): boolean {
  return (
    /(?:不要|别|无需|不需要|禁止|勿)\s*(?:写|保存|创建|生成|导出|输出|存放|放)/u.test(
      line,
    ) || /\b(?:do not|don't|never|not)\s+(?:write|save|create|generate|export|store)\b/i.test(line)
  );
}

/** 保守地区分目录授权和单文件授权。 */
function classifyExternalTarget(
  path: string,
  promptLine: string,
): ExternalWriteGrant['kind'] | undefined {
  const pathIndex = promptLine.indexOf(path);
  const before = promptLine.slice(Math.max(0, pathIndex - 32), pathIndex);
  const after = promptLine.slice(pathIndex + path.length, pathIndex + path.length + 24);
  const destinationContext = `${before} ${after}`;
  if (
    /(?:文件名|文件路径|保存为|命名为|filename|file name|save as|named as)/iu.test(
      before,
    )
  ) {
    return 'file';
  }
  if (
    /[\\/]$/.test(path) ||
    /(?:目录|文件夹|\b(?:directory|folder)\b)/iu.test(destinationContext)
  ) {
    return 'directory';
  }
  if (/\.[A-Za-z0-9]{1,16}$/.test(basename(path))) return 'file';
  if (/(?:到|至|在|下面|之下|目录下|文件夹下)\s*$/u.test(before)) {
    return 'directory';
  }
  if (/\b(?:to|into|under|at)\s*$/iu.test(before)) return 'directory';
  return undefined;
}
