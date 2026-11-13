import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Stores the lifecycle of one classroom lesson; message content lives in its JSONL transcript. */
@Entity({ name: 'lessons' })
@Index('IDX_lessons_status', ['status'])
export class LessonEntity {
  @PrimaryColumn({ type: 'varchar' })
  id!: string;

  @Column({ type: 'varchar' })
  status!: string;

  @Column({ type: 'datetime', nullable: true })
  endedAt!: Date | null;

  /** Generated post-class summary; small and queried by the landing list, so it stays in SQLite. */
  @Column({ type: 'varchar', default: 'none' })
  summaryStatus!: string;

  @Column({ type: 'text', nullable: true })
  summaryMarkdown!: string | null;

  @Column({ type: 'text', nullable: true })
  summaryError!: string | null;

  @Column({ type: 'datetime', nullable: true })
  summaryGeneratedAt!: Date | null;

  /** First teacher message of the knowledge point currently being discussed. */
  @Column({ type: 'varchar', nullable: true })
  pointStartMessageId!: string | null;

  /** Short label of the active knowledge point, produced by the director. */
  @Column({ type: 'varchar', nullable: true })
  pointLabel!: string | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
