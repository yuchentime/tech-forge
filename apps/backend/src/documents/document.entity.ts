import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Stores a document identity and whether it belongs to the shared knowledge collection. */
@Entity({ name: 'documents' })
@Index('IDX_documents_isShared', ['isShared'])
export class DocumentEntity {
  @PrimaryColumn({ type: 'varchar' })
  id!: string;

  @Column({ type: 'text' })
  title!: string;

  @Column({ type: 'boolean', default: false })
  isShared!: boolean;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
