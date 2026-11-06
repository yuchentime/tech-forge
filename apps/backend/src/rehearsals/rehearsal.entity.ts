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

  @Column({ type: 'datetime', nullable: true })
  startedAt!: Date | null;

  @Column({ type: 'datetime', nullable: true })
  endedAt!: Date | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
