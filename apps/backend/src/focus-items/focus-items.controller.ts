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
  CreateFocusItemDto,
  UpdateFocusItemNoteDto,
  type FocusItemDto,
} from './focus-items.dto';
import { FocusItemsService } from './focus-items.service';

/**
 * Exposes the saved excerpts behind the 重点关注 view.
 *
 * The global local-token hook in `main.ts` protects every route. The controller only validates and
 * delegates; ownership checks live in the service.
 */
@Controller('focus-items')
export class FocusItemsController {
  constructor(private readonly focusItems: FocusItemsService) {}

  /** Saves one excerpt selected from an assistant reply. */
  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() input: CreateFocusItemDto): Promise<FocusItemDto> {
    return this.focusItems.create(input);
  }

  /** Lists saved excerpts newest first. */
  @Get()
  list(): Promise<{ items: FocusItemDto[] }> {
    return this.focusItems.list().then((items) => ({ items }));
  }

  /** Replaces the study note of one saved excerpt; an empty note clears it. */
  @Patch(':id')
  updateNote(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() input: UpdateFocusItemNoteDto,
  ): Promise<FocusItemDto> {
    return this.focusItems.updateNote(id, input.note);
  }

  /** Deletes one saved excerpt. */
  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  remove(
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
  ): Promise<{ id: string }> {
    return this.focusItems.remove(id);
  }
}
