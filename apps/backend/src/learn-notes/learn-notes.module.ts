import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConversationsModule } from '../conversations/conversations.module';
import { LearnNotesController } from './learn-notes.controller';
import { LearnNoteEntity } from './learn-note.entity';
import { LearnNotesService } from './learn-notes.service';

/** Owns saved assistant-message excerpts and their conversation titles. */
@Module({
  imports: [
    TypeOrmModule.forFeature([LearnNoteEntity]),
    ConversationsModule,
  ],
  controllers: [LearnNotesController],
  providers: [LearnNotesService],
})
export class LearnNotesModule {}
