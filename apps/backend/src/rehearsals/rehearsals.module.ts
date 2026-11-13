import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConversationsModule } from '../conversations/conversations.module';
import { AgentModule } from '../llm/agents/AgentModule';
import { SettingsModule } from '../settings/settings.module';
import { ConversationKnowledgeFactEntity } from './conversation-knowledge-fact.entity';
import { ConversationKnowledgeFactsController } from './conversation-knowledge-facts.controller';
import { ConversationKnowledgeFactsService } from './conversation-knowledge-facts.service';
import {
  ConversationRehearsalsController,
  RehearsalPersonaController,
  RehearsalsController,
} from './rehearsals.controller';
import { RehearsalPreparingRegistry } from './rehearsal-preparing-registry';
import { RehearsalRunRegistry } from './rehearsal-run-registry';
import { RehearsalTurnEntity } from './rehearsal-turn.entity';
import { RehearsalEntity } from './rehearsal.entity';
import { RehearsalsService } from './rehearsals.service';

/** Composes the rehearsal state machine, fact worker, their HTTP boundaries and shared dependencies. */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      RehearsalEntity,
      RehearsalTurnEntity,
      ConversationKnowledgeFactEntity,
    ]),
    ConversationsModule,
    AgentModule,
    SettingsModule,
  ],
  controllers: [
    ConversationRehearsalsController,
    RehearsalsController,
    RehearsalPersonaController,
    ConversationKnowledgeFactsController,
  ],
  providers: [
    RehearsalsService,
    ConversationKnowledgeFactsService,
    RehearsalRunRegistry,
    RehearsalPreparingRegistry,
  ],
  exports: [RehearsalsService, ConversationKnowledgeFactsService],
})
export class RehearsalsModule {}
