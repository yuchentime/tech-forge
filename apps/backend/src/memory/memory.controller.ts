import { Controller, Delete, Get, Param } from '@nestjs/common';
import { MemoryService } from './memory.service';

/** Exposes the local memory list and deletion used by the settings view. */
@Controller('memories')
export class MemoryController {
  /** Injects the memory owner; the controller never touches the database directly. */
  constructor(private readonly memory: MemoryService) {}

  /** Returns active memories without embeddings. */
  @Get()
  list() {
    return this.memory.listForUi();
  }

  /** Physically removes one memory. */
  @Delete(':id')
  remove(@Param('id') id: string) {
    return this.memory.deleteMemory(id);
  }

  /** Removes every stored memory after the user confirms in the settings view. */
  @Delete()
  clear() {
    return this.memory.clearMemories();
  }
}
