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
import { RehearsalEntity } from './rehearsal.entity';

/** Stores one rehearsal question, its submitted answer, and its current evaluation. */
@Entity({ name: 'rehearsal_turns' })
@Index('IDX_rehearsal_turns_rehearsal_sequence', ['rehearsalId', 'sequenceNo'], {
  unique: true,
})
@Index('UQ_rehearsal_turns_rehearsal_answerRequestId', [
  'rehearsalId',
  'answerRequestId',
], { unique: true })
export class RehearsalTurnEntity {
  @PrimaryColumn({ type: 'varchar' })
  id!: string;

  @Column({ type: 'varchar' })
  rehearsalId!: string;

  @ManyToOne(() => RehearsalEntity, { nullable: false, onDelete: 'NO ACTION' })
  @JoinColumn({ name: 'rehearsalId' })
  rehearsal!: RehearsalEntity;

  @Column({ type: 'integer' })
  sequenceNo!: number;

  /** `base` for a new knowledge point, `follow_up` for a drill-down on the same one. */
  @Column({ type: 'varchar', default: 'base' })
  kind!: string;

  /** Sequence number of the base question this turn belongs to. */
  @Column({ type: 'integer', default: 0 })
  baseSequenceNo!: number;

  /** 0 for a base question, 1 or 2 for follow-ups. */
  @Column({ type: 'integer', default: 0 })
  followUpDepth!: number;

  @Column({ type: 'varchar', nullable: true })
  pointId!: string | null;

  @Column({ type: 'text' })
  question!: string;

  @Column({ type: 'text', nullable: true })
  answer!: string | null;

  @Column({ type: 'text', nullable: true })
  evaluationJson!: string | null;

  @Column({ type: 'varchar' })
  status!: string;

  @Column({ type: 'varchar', nullable: true })
  answerRequestId!: string | null;

  @Column({ type: 'datetime' })
  askedAt!: Date;

  @Column({ type: 'datetime', nullable: true })
  answeredAt!: Date | null;

  @Column({ type: 'datetime', nullable: true })
  evaluatedAt!: Date | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
