import { Column, Entity, PrimaryColumn } from 'typeorm';

/** Stores one conversation's serialized Pi session entries for context restoration. */
@Entity({ name: 'pi_session_snapshots' })
export class PiSessionSnapshotEntity {
  @PrimaryColumn({ name: 'conversation_id', type: 'text' })
  conversationId!: string;

  @Column({ name: 'entries_json', type: 'text' })
  entriesJson!: string;
}
