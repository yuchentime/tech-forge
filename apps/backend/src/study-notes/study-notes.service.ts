import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ConversationsService } from '../conversations/conversations.service';
import type { CreateStudyNoteDto, StudyNoteDto } from './study-notes.dto';
import { StudyNoteEntity } from './study-note.entity';

/** Longest note the page accepts; counted in Unicode code points so emoji count once. */
const MAX_NOTE_CHARACTERS = 2000;

/**
 * Owns the notes the user writes on the 学习笔记 page.
 *
 * A note is plain text and is rendered verbatim, never as Markdown. The conversation link is
 * optional but must still exist when supplied, so "进入会话" never points at a deleted row.
 */
@Injectable()
export class StudyNotesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly conversations: ConversationsService,
  ) {}

  /** Stores one note, optionally attached to an existing conversation. */
  async create(input: CreateStudyNoteDto): Promise<StudyNoteDto> {
    // Line endings are unified and the outside trimmed; the user's own indentation is kept.
    const content = input.content.replace(/\r\n?/g, '\n').trim();
    if (!content) {
      throw new BadRequestException('笔记内容不能为空。');
    }
    if (Array.from(content).length > MAX_NOTE_CHARACTERS) {
      throw new BadRequestException('笔记过长，请控制在 2000 字以内。');
    }

    const conversationId = input.conversationId ?? null;
    if (conversationId) {
      // A dangling id would render a "进入会话" button that can never load anything.
      const titles = await this.conversations.getConversationDisplayTitles([
        conversationId,
      ]);
      if (!titles.has(conversationId)) {
        throw new NotFoundException('会话不存在，可能已被删除。');
      }
    }

    const repository = this.dataSource.getRepository(StudyNoteEntity);
    const note = repository.create({ id: randomUUID(), conversationId, content });
    await repository.save(note);
    return (await this.toDtos([note]))[0];
  }

  /** Returns every note newest first, with the current conversation titles. */
  async list(): Promise<StudyNoteDto[]> {
    const notes = await this.dataSource
      .getRepository(StudyNoteEntity)
      .find({ order: { createdAt: 'DESC' } });
    return this.toDtos(notes);
  }

  /** Deletes one note; a missing row is reported so the UI can refresh. */
  async remove(id: string): Promise<{ id: string }> {
    const result = await this.dataSource
      .getRepository(StudyNoteEntity)
      .delete({ id });
    if (!result.affected) {
      throw new NotFoundException('这条笔记不存在，可能已被删除。');
    }
    return { id };
  }

  /** Maps rows to the wire shape, resolving the linked conversation titles in one query. */
  private async toDtos(notes: StudyNoteEntity[]): Promise<StudyNoteDto[]> {
    const conversationIds = notes
      .map((note) => note.conversationId)
      .filter((id): id is string => id !== null);
    const titles =
      await this.conversations.getConversationDisplayTitles(conversationIds);
    return notes.map((note) => ({
      id: note.id,
      conversationId: note.conversationId,
      conversationTitle: note.conversationId
        ? (titles.get(note.conversationId) ?? '未知会话')
        : null,
      content: note.content,
      createdAt: note.createdAt.toISOString(),
    }));
  }
}
