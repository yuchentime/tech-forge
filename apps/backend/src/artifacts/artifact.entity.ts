import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { ConversationEntity } from '../conversations/conversation.entity';

/**
 * Stores one file the Agent created or modified during a conversation.
 *
 * Paths are stored relative to a root that is derivable from the conversation, so a moved
 * configuration directory or a restored backup keeps resolving. Files the user asked to place
 * elsewhere keep their absolute path and are flagged as external.
 */
@Entity({ name: 'artifacts' })
@Index('IDX_artifacts_conversation_createdAt', ['conversationId', 'createdAt'])
@Index('UQ_artifacts_conversation_path', [
  'conversationId',
  'pathKind',
  'relativePath',
  'absolutePath',
], { unique: true })
export class ArtifactEntity {
  @PrimaryColumn({ type: 'varchar' })
  id!: string;

  @Column({ type: 'varchar' })
  conversationId!: string;

  @ManyToOne(() => ConversationEntity, { nullable: false, onDelete: 'NO ACTION' })
  @JoinColumn({ name: 'conversationId' })
  conversation!: ConversationEntity;

  /** User message whose turn produced or last touched the file. */
  @Column({ type: 'varchar', nullable: true })
  userMessageId!: string | null;

  /** `session` resolves under the session workspace, `external` uses the absolute path. */
  @Column({ type: 'varchar' })
  pathKind!: string;

  /**
   * Session files store the POSIX path below the session workspace.
   *
   * Empty (not null) for external files: SQLite treats NULLs as distinct in a unique index, which
   * would let repeated writes to one external path insert duplicate rows.
   */
  @Column({ type: 'text' })
  relativePath!: string;

  /** Absolute destination for `external` files; empty for session files. */
  @Column({ type: 'text' })
  absolutePath!: string;

  /** Display name only: the sidebar never shows a path. */
  @Column({ type: 'text' })
  fileName!: string;

  /** Preview family chosen from the extension: markdown, mermaid, json, jsonl or text. */
  @Column({ type: 'varchar' })
  contentFormat!: string;

  @Column({ type: 'varchar', nullable: true })
  mimeType!: string | null;

  @Column({ type: 'integer', nullable: true })
  byteSize!: number | null;

  /** Content hash of the last write, used to report files changed outside the app. */
  @Column({ type: 'varchar', nullable: true })
  fileHash!: string | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
