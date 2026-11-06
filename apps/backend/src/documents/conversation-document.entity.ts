import {
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { ConversationEntity } from '../conversations/conversation.entity';
import { DocumentEntity } from './document.entity';

/** Stores the explicit association between a conversation and a reusable document. */
@Entity({ name: 'conversation_documents' })
export class ConversationDocumentEntity {
  @PrimaryColumn({ type: 'varchar' })
  conversationId!: string;

  @ManyToOne(() => ConversationEntity, { nullable: false, onDelete: 'NO ACTION' })
  @JoinColumn({ name: 'conversationId' })
  conversation!: ConversationEntity;

  @PrimaryColumn({ type: 'varchar' })
  documentId!: string;

  @ManyToOne(() => DocumentEntity, { nullable: false, onDelete: 'NO ACTION' })
  @JoinColumn({ name: 'documentId' })
  document!: DocumentEntity;

  @CreateDateColumn({ type: 'datetime' })
  addedAt!: Date;
}
