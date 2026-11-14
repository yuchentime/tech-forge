import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { CreateStudyNoteDto, type StudyNoteDto } from './study-notes.dto';
import { StudyNotesService } from './study-notes.service';

/**
 * Exposes the user-written notes behind the 学习笔记 view.
 *
 * The global local-token hook in `main.ts` protects every route. The controller only validates and
 * delegates; the conversation check lives in the service.
 */
@Controller('study-notes')
export class StudyNotesController {
  constructor(private readonly studyNotes: StudyNotesService) {}

  /** Saves one note written in the add-note dialog. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() input: CreateStudyNoteDto): Promise<StudyNoteDto> {
    return this.studyNotes.create(input);
  }

  /** Lists notes newest first. */
  @Get()
  list(): Promise<{ items: StudyNoteDto[] }> {
    return this.studyNotes.list().then((items) => ({ items }));
  }

  /** Deletes one note. */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<{ id: string }> {
    return this.studyNotes.remove(id);
  }
}
