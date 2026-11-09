import {
  CreateDateColumn,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
  Column,
} from 'typeorm';

/** Stores the persistent identity and title of one personal learning conversation. */
@Entity({ name: 'conversations' })
export class ConversationEntity {
  @PrimaryColumn({ type: 'varchar' })
  id!: string;

  @Column({ type: 'text', nullable: true })
  title!: string | null;

  /**
   * Conversation-level preferences as JSON; currently only the knowledge scope.
   * Kept out of message rows: preferences are one value per conversation, not per turn.
   */
  @Column({ type: 'text', nullable: true })
  metadataJson!: string | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
