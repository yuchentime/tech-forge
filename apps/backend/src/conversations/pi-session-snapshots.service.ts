import { Injectable } from '@nestjs/common';
import type { SessionEntry } from '@earendil-works/pi-coding-agent';
import { DataSource, type Repository } from 'typeorm';
import { PiSessionSnapshotEntity } from './pi-session-snapshot.entity';

/** Owns the single Pi session entry snapshot stored per conversation. */
@Injectable()
export class PiSessionSnapshotsService {
  private readonly snapshots: Repository<PiSessionSnapshotEntity>;

  /** Injects TypeORM for short snapshot reads and writes that never span model calls. */
  constructor(dataSource: DataSource) {
    this.snapshots = dataSource.getRepository(PiSessionSnapshotEntity);
  }

  /** Returns the stored Pi entries, or null when the conversation has no snapshot yet. */
  async getSnapshot(conversationId: string): Promise<SessionEntry[] | null> {
    const snapshot = await this.snapshots.findOneBy({ conversationId });
    if (!snapshot) return null;
    return parseEntries(snapshot.entriesJson);
  }

  /** Replaces the whole Pi entry snapshot for one conversation in a single upsert. */
  async saveSnapshot(
    conversationId: string,
    entries: readonly SessionEntry[],
  ): Promise<void> {
    await this.snapshots.upsert(
      { conversationId, entriesJson: JSON.stringify(entries) },
      { conflictPaths: ['conversationId'] },
    );
  }

  /** Removes the snapshot after its conversation or restored context is discarded. */
  async deleteSnapshot(conversationId: string): Promise<void> {
    await this.snapshots.delete({ conversationId });
  }
}

/** Parses an entries_json payload, rejecting non-array values instead of guessing. */
function parseEntries(entriesJson: string): SessionEntry[] {
  const value: unknown = JSON.parse(entriesJson);
  if (!Array.isArray(value)) {
    throw new Error('Stored Pi session snapshot is malformed.');
  }
  return value as SessionEntry[];
}
