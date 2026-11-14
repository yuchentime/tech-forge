import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildDatabaseOptions } from './database/database.options';
import { ChatModule } from './chat/chat.module';
import { ArtifactsModule } from './artifacts/artifacts.module';
import { AssessmentsModule } from './assessments/assessments.module';
import { ClassroomModule } from './classroom/classroom.module';
import { ConversationsModule } from './conversations/conversations.module';
import { DocumentsModule } from './documents/documents.module';
import { EmbeddingModule } from './embedding/embedding.module';
import { LearnNotesModule } from './learn-notes/learn-notes.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { LessonsModule } from './lessons/lessons.module';
import { AgentModule } from './llm/agents/AgentModule';
import { MemoryModule } from './memory/memory.module';
import { PlatformModule } from './platform/platform.module';
import { RehearsalsModule } from './rehearsals/rehearsals.module';
import { RetrievalModule } from './retrieval/retrieval.module';
import { SettingsModule } from './settings/settings.module';
import { StudyNotesModule } from './study-notes/study-notes.module';

/** Composes the active backend platform and domain modules. */
@Module({
  imports: [
    TypeOrmModule.forRootAsync({ useFactory: buildDatabaseOptions }),
    PlatformModule,
    DocumentsModule,
    KnowledgeModule,
    RetrievalModule,
    EmbeddingModule,
    ConversationsModule,
    RehearsalsModule,
    LessonsModule,
    ClassroomModule,
    SettingsModule,
    AssessmentsModule,
    ArtifactsModule,
    MemoryModule,
    ChatModule,
    AgentModule,
    LearnNotesModule,
    StudyNotesModule,
  ],
})
export class AppModule {}
