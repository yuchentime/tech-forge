import { IsOptional, IsUUID } from 'class-validator';

/** Describes one conversation artifact row as the sidebar consumes it. */
export interface ArtifactSummaryDto {
  id: string;
  /** Display name only; the sidebar never shows a path. */
  fileName: string;
  /** Preview family: markdown, mermaid, json, jsonl or text. */
  contentFormat: string;
  byteSize: number | null;
  createdAt: string;
  updatedAt: string;
  /** Turn that produced or last touched the file. */
  userMessageId: string | null;
  /** True when the stored path no longer exists on disk. */
  missing: boolean;
  /** True when the user asked for a destination outside the session workspace. */
  external: boolean;
}

/** Describes the text payload of one artifact preview. */
export interface ArtifactContentDto {
  id: string;
  fileName: string;
  contentFormat: string;
  content: string;
  /** True when the file is larger than the preview cap and only its head was returned. */
  truncated: boolean;
  /** True when the file does not look like UTF-8 text, so no preview is meaningful. */
  binary: boolean;
  byteSize: number | null;
  updatedAt: string;
}

/** Validates the optional per-turn filter for the artifact list API. */
export class ListArtifactsQueryDto {
  @IsOptional()
  @IsUUID('4')
  userMessageId?: string;
}

/** Describes where one artifact lives, so the desktop shell can reveal it. */
export interface ArtifactLocationDto {
  directory: string;
  filePath: string;
  fileExists: boolean;
  directoryExists: boolean;
}
