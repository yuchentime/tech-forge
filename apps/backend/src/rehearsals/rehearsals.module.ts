import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConversationsModule } from '../conversations/conversations.module';
import { LlmModule } from '../llm/llm.module';
import { SettingsModule } from '../settings/settings.module';
import {
  ConversationRehearsalsController,
  RehearsalPersonaController,
  RehearsalsController,
} from './rehearsals.controller';
import { RehearsalRunRegistry } from './rehearsal-run-registry';
import { RehearsalTurnEntity } from './rehearsal-turn.entity';
import { RehearsalEntity } from './rehearsal.entity';
import { RehearsalsService } from './rehearsals.service';

/** Composes the rehearsal state machine, its HTTP boundary and shared dependencies. */
@Module({
  imports: [
    TypeOrmModule.forFeature([RehearsalEntity, RehearsalTurnEntity]),
    ConversationsModule,
    LlmModule,
    SettingsModule,
  ],
  controllers: [
    ConversationRehearsalsController,
    RehearsalsController,
    RehearsalPersonaController,
  ],
  providers: [RehearsalsService, RehearsalRunRegistry],
  exports: [RehearsalsService],
})
export class RehearsalsModule {}
