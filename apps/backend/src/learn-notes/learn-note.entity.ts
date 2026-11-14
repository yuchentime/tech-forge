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
 * Stores one excerpt of an assistant reply that the user saved to 学习笔记.
 *
 * The message id is the navigation anchor. `messageSequenceNo` is copied from the message row so the
 * list can stay ordered without joining transcripts, and `messageIndex` is the visible 1-based
 * ordinal used only for display.
 */
@Entity({ name: 'learn_notes' })
@Index('UQ_learn_notes_message_quote', ['messageId', 'quoteKey'], { unique: true })
@Index('IDX_learn_notes_createdAt', ['createdAt'])
@Index('IDX_learn_notes_conversation', ['conversationId'])
export class LearnNoteEntity {
  @PrimaryColumn({ type: 'varchar' })
  id!: string;

  @Column({ type: 'varchar' })
  conversationId!: string;

  @ManyToOne(() => ConversationEntity, { nullable: false, onDelete: 'NO ACTION' })
  @JoinColumn({ name: 'conversationId' })
  conversation!: ConversationEntity;

  @Column({ type: 'varchar' })
  messageId!: string;

  @Column({ type: 'integer' })
  messageSequenceNo!: number;

  @Column({ type: 'integer' })
  messageIndex!: number;

  @Column({ type: 'text' })
  quote!: string;

  /** Hash of the normalized quote; SQLite cannot index a long text column reliably. */
  @Column({ type: 'varchar' })
  quoteKey!: string;

  /** User-written study note; null when the excerpt has no note yet. */
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
