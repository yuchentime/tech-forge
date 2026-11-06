import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { DocumentVersionEntity } from './document-version.entity';

/** Stores one text chunk and its optional source locator for a document version. */
@Entity({ name: 'document_chunks' })
@Index('UQ_document_chunks_version_sequence', ['documentVersionId', 'sequenceNo'], {
  unique: true,
})
export class DocumentChunkEntity {
  @PrimaryColumn({ type: 'varchar' })
  id!: string;

  @Column({ type: 'varchar' })
  documentVersionId!: string;

  @ManyToOne(() => DocumentVersionEntity, { nullable: false, onDelete: 'NO ACTION' })
  @JoinColumn({ name: 'documentVersionId' })
  documentVersion!: DocumentVersionEntity;

  @Column({ type: 'integer' })
  sequenceNo!: number;

  @Column({ type: 'text' })
  content!: string;

  @Column({ type: 'text', nullable: true })
  locatorJson!: string | null;

  @CreateDateColumn({ type: 'datetime' })
  createdAt!: Date;
}
