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
import { DocumentEntity } from './document.entity';

/** Stores a source-file version and its workspace-relative location and processing state. */
@Entity({ name: 'document_versions' })
@Index('UQ_document_versions_document_versionNo', ['documentId', 'versionNo'], {
  unique: true,
})
export class DocumentVersionEntity {
  @PrimaryColumn({ type: 'varchar' })
  id!: string;

  @Column({ type: 'varchar' })
  documentId!: string;

  @ManyToOne(() => DocumentEntity, { nullable: false, onDelete: 'NO ACTION' })
  @JoinColumn({ name: 'documentId' })
  document!: DocumentEntity;

  @Column({ type: 'integer' })
  versionNo!: number;

  @Column({ type: 'text' })
  originalName!: string;

  @Column({ type: 'varchar' })
  mimeType!: string;

  @Column({ type: 'text' })
  workspaceRelativePath!: string;

  @Column({ type: 'integer', nullable: true })
  byteSize!: number | null;

  @Column({ type: 'varchar', nullable: true })
  contentHash!: string | null;

  @Column({ type: 'varchar' })
  processingStatus!: string;

  @Column({ type: 'text', nullable: true })
  processingError!: string | null;

  /** Derived catalog state; source bytes remain available even if provider summarisation fails. */
  @Column({ type: 'varchar', default: 'pending' })
  catalogStatus!: string;

  @Column({ type: 'text', nullable: true })
  catalogSummary!: string | null;

  @Column({ type: 'text', nullable: true })
  catalogKeywordsJson!: string | null;

  @Column({ type: 'varchar', nullable: true })
  catalogDocumentType!: string | null;

  @Column({ type: 'text', nullable: true })
  catalogError!: string | null;

  @Column({ type: 'datetime', nullable: true })
  catalogedAt!: Date | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'datetime' })
  updatedAt!: Date;
}
