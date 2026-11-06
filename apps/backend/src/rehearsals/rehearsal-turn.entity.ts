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
