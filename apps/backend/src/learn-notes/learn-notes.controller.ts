import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
} from '@nestjs/common';
import {
  CreateLearnNoteDto,
  UpdateLearnNoteDto,
  type LearnNoteDto,
} from './learn-notes.dto';
import { LearnNotesService } from './learn-notes.service';

/**
 * Exposes the saved excerpts behind the 学习笔记 view.
 *
 * The global local-token hook in `main.ts` protects every route. The controller only validates and
 * delegates; ownership checks live in the service.
 */
@Controller('learn-notes')
export class LearnNotesController {
  constructor(private readonly learnNotes: LearnNotesService) {}

  /** Saves one excerpt selected from an assistant reply. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() input: CreateLearnNoteDto): Promise<LearnNoteDto> {
    return this.learnNotes.create(input);
  }

  /** Lists saved excerpts newest first. */
  @Get()
  list(): Promise<{ items: LearnNoteDto[] }> {
    return this.learnNotes.list().then((items) => ({ items }));
  }

  /** Replaces the study note of one saved excerpt; an empty note clears it. */
  @Patch(':id')
  updateNote(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: UpdateLearnNoteDto,
  ): Promise<LearnNoteDto> {
    return this.learnNotes.updateNote(id, input.note);
  }

  /** Deletes one saved excerpt. */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<{ id: string }> {
    return this.learnNotes.remove(id);
  }
}
