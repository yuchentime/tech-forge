import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { buildDatabaseOptions } from './database/database.options';
import { AgentModule } from './agent/agent.module';
import { ArtifactsModule } from './artifacts/artifacts.module';
import { AssessmentsModule } from './assessments/assessments.module';
import { ConversationsModule } from './conversations/conversations.module';
import { CoursesModule } from './courses/courses.module';
import { DocumentsModule } from './documents/documents.module';
import { EmbeddingModule } from './embedding/embedding.module';
import { JobsModule } from './jobs/jobs.module';
import { KnowledgeModule } from './knowledge/knowledge.module';
import { LessonsModule } from './lessons/lessons.module';
import { LlmModule } from './llm/llm.module';
import { MemoryModule } from './memory/memory.module';
import { PlatformModule } from './platform/platform.module';
import { RehearsalsModule } from './rehearsals/rehearsals.module';
import { RetrievalModule } from './retrieval/retrieval.module';
import { TeachingModule } from './teaching/teaching.module';

@Module({
  imports: [
    TypeOrmModule.forRootAsync({ useFactory: buildDatabaseOptions }),
    PlatformModule,
    CoursesModule,
    LessonsModule,
    TeachingModule,
    DocumentsModule,
    KnowledgeModule,
    RetrievalModule,
    EmbeddingModule,
    ConversationsModule,
    RehearsalsModule,
    AssessmentsModule,
    ArtifactsModule,
    MemoryModule,
    AgentModule,
    LlmModule,
    JobsModule,
  ],
})
export class AppModule {}
