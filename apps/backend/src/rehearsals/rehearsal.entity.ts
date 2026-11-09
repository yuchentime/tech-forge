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

/** Stores the lifecycle of one rehearsal associated with a conversation. */
@Entity({ name: 'rehearsals' })
@Index('IDX_rehearsals_conversation_createdAt', [
  'conversationId',
  'createdAt',
])
@Index('UQ_rehearsals_conversation_startRequestId', [
  'conversationId',
  'startRequestId',
], { unique: true })
export class RehearsalEntity {
  @PrimaryColumn({ type: 'varchar' })
  id!: string;

  @Column({ type: 'varchar' })
  conversationId!: string;

  @ManyToOne(() => ConversationEntity, { nullable: false, onDelete: 'NO ACTION' })
  @JoinColumn({ name: 'conversationId' })
  conversation!: ConversationEntity;

  @Column({ type: 'varchar' })
  status!: string;

  @Column({ type: 'varchar', nullable: true })
  startRequestId!: string | null;

  /** Optional student profile used only as a questioning perspective. */
  @Column({ type: 'text', nullable: true })
  personaText!: string | null;

  /** Parent conversation sequence at the time this batch started; later messages are excluded. */
  @Column({ type: 'integer', nullable: true })
  contextUpToSequenceNo!: number | null;

  /** Serialized topic, learning summary and knowledge-point plan. */
  @Column({ type: 'text', nullable: true })
  planJson!: string | null;

  @Column({ type: 'integer', default: 0 })
  askedQuestionCount!: number;

  @Column({ type: 'integer', default: 0 })
  baseQuestionCount!: number;

  @Column({ type: 'integer', default: 0 })
  skippedCount!: number;

  /** Serialized overall evaluation; per-question evaluations live on rehearsal_turns. */
  @Column({ type: 'text', nullable: true })
  overallEvaluationJson!: string | null;

  @Column({ type: 'varchar', nullable: true })
  endReason!: string | null;

  /**
   * Whether the normal-chat digest already carried this rehearsal into the Pi context.
   *
   * Delivery is one-shot: the digest is appended as a custom message entry, so the model keeps
   * seeing it from the snapshot instead of receiving it again on every turn.
   */
  @Column({ type: 'boolean', default: false })
  loadedContext!: boolean;

  @Column({ type: 'datetime', nullable: true })
  startedAt!: Date | null;

  @Column({ type: 'datetime', nullable: true })
  endedAt!: Date | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
