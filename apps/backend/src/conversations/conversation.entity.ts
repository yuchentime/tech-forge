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

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
