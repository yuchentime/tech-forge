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
 * Stores one note the user wrote on the 学习笔记 page.
 *
 * Unlike a focus item, a note has no message anchor and no quoted text: it is free text, and the
 * conversation link is optional context used only for the "进入会话" shortcut.
 */
@Entity({ name: 'study_notes' })
@Index('IDX_study_notes_createdAt', ['createdAt'])
@Index('IDX_study_notes_conversation', ['conversationId'])
export class StudyNoteEntity {
  @PrimaryColumn({ type: 'varchar' })
  id!: string;

  /** Conversation the note refers to; null when the note stands alone. */
  @Column({ type: 'varchar', nullable: true })
  conversationId!: string | null;

  @ManyToOne(() => ConversationEntity, { nullable: true, onDelete: 'NO ACTION' })
  @JoinColumn({ name: 'conversationId' })
  conversation!: ConversationEntity | null;

  @Column({ type: 'text' })
  content!: string;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
