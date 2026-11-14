import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ConversationsService } from '../conversations/conversations.service';
import { MessageEntity } from '../conversations/message.entity';
import type { CreateLearnNoteDto, LearnNoteDto } from './learn-notes.dto';
import { LearnNoteEntity } from './learn-note.entity';

/** Longest saved excerpt accepted by Learn Notes; counted in Unicode code points. */
const MAX_QUOTE_CHARACTERS = 1000;

/** Longest study note accepted for one excerpt; counted in Unicode code points. */
const MAX_NOTE_CHARACTERS = 2000;

/**
 * Owns saved assistant-message excerpts.
 *
 * Creation validates that the target message still belongs to the conversation and is an assistant
 * reply. The message id is the navigation anchor; the quote is plain display text and is never
 * rendered as Markdown.
 */
@Injectable()
export class LearnNotesService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly conversations: ConversationsService,
  ) {}

  /** Saves one excerpt, returning the existing row when the same quote was already saved. */
  async create(input: CreateLearnNoteDto): Promise<LearnNoteDto> {
    const quote = normalizeQuote(input.quote);
    if (!quote) {
      throw new BadRequestException('选中的内容不能为空。');
    }
    if (Array.from(quote).length > MAX_QUOTE_CHARACTERS) {
      throw new BadRequestException('选中的内容过长，请分次添加。');
    }
    const note = normalizeNote(input.note ?? '');
    if (note !== null && Array.from(note).length > MAX_NOTE_CHARACTERS) {
      throw new BadRequestException('备注过长，请控制在 2000 字以内。');
    }

    const message = await this.dataSource
      .getRepository(MessageEntity)
      .findOneBy({ id: input.messageId, conversationId: input.conversationId });
    if (!message) {
      throw new NotFoundException('消息不存在，可能已被删除。');
    }
    if (message.role !== 'assistant') {
      throw new BadRequestException('只能关注助手回复中的内容。');
    }

    const repository = this.dataSource.getRepository(LearnNoteEntity);
    const quoteKey = createHash('sha256').update(quote, 'utf8').digest('hex');
    const existing = await repository.findOneBy({
      messageId: input.messageId,
      quoteKey,
    });
    if (existing) {
      // Re-adding the same quote must not silently drop the note typed in the dialog, while a
      // blank note never clears a note the user wrote earlier.
      if (note !== null && existing.note !== note) {
        existing.note = note;
        await repository.save(existing);
      }
      return (await this.toDtos([existing]))[0];
    }

    const item = repository.create({
      id: randomUUID(),
      conversationId: input.conversationId,
      messageId: input.messageId,
      messageSequenceNo: message.sequenceNo,
      messageIndex: input.messageIndex,
      quote,
      quoteKey,
      note,
    });
    try {
      await repository.save(item);
    } catch (error) {
      // A second click can race the lookup above; the unique index is the source of truth.
      const duplicate = await repository.findOneBy({
        messageId: input.messageId,
        quoteKey,
      });
      if (duplicate) {
        if (note !== null && duplicate.note !== note) {
          duplicate.note = note;
          await repository.save(duplicate);
        }
        return (await this.toDtos([duplicate]))[0];
      }
      throw error;
    }
    return (await this.toDtos([item]))[0];
  }

  /** Returns every saved excerpt newest first, with the current conversation titles. */
  async list(): Promise<LearnNoteDto[]> {
    const items = await this.dataSource.getRepository(LearnNoteEntity).find({
      order: { createdAt: 'DESC' },
    });
    return this.toDtos(items);
  }

  /** Replaces the study note; an empty note clears it without deleting the excerpt. */
  async updateNote(id: string, rawNote: string): Promise<LearnNoteDto> {
    const note = normalizeNote(rawNote);
    if (note !== null && Array.from(note).length > MAX_NOTE_CHARACTERS) {
      throw new BadRequestException('备注过长，请控制在 2000 字以内。');
    }

    const repository = this.dataSource.getRepository(LearnNoteEntity);
    const item = await repository.findOneBy({ id });
    if (!item) {
      throw new NotFoundException('这条学习笔记不存在，可能已被删除。');
    }
    item.note = note;
    await repository.save(item);
    return (await this.toDtos([item]))[0];
  }

  /** Deletes one saved excerpt; a missing row is reported so the UI can refresh. */
  async remove(id: string): Promise<{ id: string }> {
    const result = await this.dataSource
      .getRepository(LearnNoteEntity)
      .delete({ id });
    if (!result.affected) {
      throw new NotFoundException('这条学习笔记不存在，可能已被删除。');
    }
    return { id };
  }

  /** Maps rows to the wire shape, resolving conversation titles in one query. */
  private async toDtos(items: LearnNoteEntity[]): Promise<LearnNoteDto[]> {
    const titles = await this.conversations.getConversationDisplayTitles(
      items.map((item) => item.conversationId),
    );
    return items.map((item) => ({
      id: item.id,
      conversationId: item.conversationId,
      conversationTitle: titles.get(item.conversationId) ?? '未知会话',
      messageId: item.messageId,
      messageIndex: item.messageIndex,
      quote: item.quote,
      note: item.note,
      createdAt: item.createdAt.toISOString(),
    }));
  }
}

/** Normalizes line endings and trims the outside, keeping code indentation intact. */
function normalizeQuote(raw: string): string {
  return raw.replace(/\r\n?/g, '\n').trim();
}

/** Normalizes note line endings; an empty note is stored as null so "no note" is unambiguous. */
function normalizeNote(raw: string): string | null {
  const note = raw.replace(/\r\n?/g, '\n').trim();
  return note ? note : null;
}
