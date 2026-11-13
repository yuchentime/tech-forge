import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConversationsModule } from '../conversations/conversations.module';
import { FocusItemsController } from './focus-items.controller';
import { FocusItemEntity } from './focus-item.entity';
import { FocusItemsService } from './focus-items.service';

/** Owns saved assistant-message excerpts and their conversation titles. */
@Module({
  imports: [
    TypeOrmModule.forFeature([FocusItemEntity]),
    ConversationsModule,
  ],
  controllers: [FocusItemsController],
  providers: [FocusItemsService],
})
export class FocusItemsModule {}
