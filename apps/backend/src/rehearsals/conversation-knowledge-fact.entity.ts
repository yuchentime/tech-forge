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
 * Stores the single derived knowledge-mastery fact for one conversation.
 *
 * The row doubles as the durable generation signal: `generationStatus` lets a report
 * commit mark work pending and lets the background worker detect new evidence that
 * arrived while an older model call was still running. Published content is kept
 * intact across `pending`/`running`/`failed`, so consumers never see a half update.
 */
@Entity({ name: 'conversation_knowledge_facts' })
@Index('IDX_conversation_knowledge_facts_generationStatus', ['generationStatus'])
export class ConversationKnowledgeFactEntity {
  @PrimaryColumn({ type: 'varchar' })
  conversationId!: string;

  @ManyToOne(() => ConversationEntity, { nullable: false, onDelete: 'NO ACTION' })
  @JoinColumn({ name: 'conversationId' })
  conversation!: ConversationEntity;

  /** Published summary; null until the first successful generation. */
  @Column({ type: 'text', nullable: true })
  summary!: string | null;

  /** Serialized knowledge-point details; null until the first successful generation. */
  @Column({ type: 'text', nullable: true })
  knowledgePointDetailsJson!: string | null;

  /** Serialized distinct tag strings; null until the first successful generation. */
  @Column({ type: 'text', nullable: true })
  tagsJson!: string | null;

  @Column({ type: 'varchar', nullable: true })
  masteryLevel!: string | null;

  /** pending | running | completed | failed. */
  @Column({ type: 'varchar', default: 'pending' })
  generationStatus!: string;

  /** Bounded, sanitized failure summary; only set while the latest attempt failed. */
  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  /** Time of the most recent successful publish; never the start of the current attempt. */
  @Column({ type: 'datetime', nullable: true })
  generatedAt!: Date | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
