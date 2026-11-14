import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConversationsModule } from '../conversations/conversations.module';
import { StudyNotesController } from './study-notes.controller';
import { StudyNoteEntity } from './study-note.entity';
import { StudyNotesService } from './study-notes.service';

/** Owns user-written notes and their optional conversation titles. */
@Module({
  imports: [TypeOrmModule.forFeature([StudyNoteEntity]), ConversationsModule],
  controllers: [StudyNotesController],
  providers: [StudyNotesService],
})
export class StudyNotesModule {}
