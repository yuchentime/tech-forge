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

/** Stores a conversation-produced artifact and its file under the active workspace. */
@Entity({ name: 'artifacts' })
@Index('IDX_artifacts_conversation_createdAt', ['conversationId', 'createdAt'])
export class ArtifactEntity {
  @PrimaryColumn({ type: 'varchar' })
  id!: string;

  @Column({ type: 'varchar' })
  conversationId!: string;

  @ManyToOne(() => ConversationEntity, { nullable: false, onDelete: 'NO ACTION' })
  @JoinColumn({ name: 'conversationId' })
  conversation!: ConversationEntity;

  @Column({ type: 'varchar' })
  contentFormat!: string;

  @Column({ type: 'text' })
  fileName!: string;

  @Column({ type: 'text' })
  workspaceRelativePath!: string;

  @Column({ type: 'varchar', nullable: true })
  mimeType!: string | null;

  @Column({ type: 'varchar', nullable: true })
  fileHash!: string | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
