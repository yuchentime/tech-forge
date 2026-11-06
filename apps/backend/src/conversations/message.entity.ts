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
import { ConversationEntity } from './conversation.entity';

/** Stores one ordered conversation message and the context references used for it. */
@Entity({ name: 'messages' })
@Index('IDX_messages_conversation_sequence', ['conversationId', 'sequenceNo'], {
  unique: true,
})
@Index('IDX_messages_conversation_createdAt', ['conversationId', 'createdAt'])
@Index('UQ_messages_conversation_requestId', ['conversationId', 'requestId'], {
  unique: true,
})
export class MessageEntity {
  @PrimaryColumn({ type: 'varchar' })
  id!: string;

  @Column({ type: 'varchar' })
  conversationId!: string;

  @ManyToOne(() => ConversationEntity, { nullable: false, onDelete: 'NO ACTION' })
  @JoinColumn({ name: 'conversationId' })
  conversation!: ConversationEntity;

  @Column({ type: 'integer' })
  sequenceNo!: number;

  @Column({ type: 'varchar' })
  role!: string;

  @Column({ type: 'text' })
  contentJson!: string;

  @Column({ type: 'varchar' })
  status!: string;

  @Column({ type: 'varchar', nullable: true })
  requestId!: string | null;

  @Column({ type: 'text', nullable: true })
  contextRefsJson!: string | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
