import { Module } from '@nestjs/common';
import { HealthModule } from '../health/health.module';
import { DocumentParserModule } from './document-parser/document-parser.module';

/** Composition point for backend platform capabilities. */
@Module({ imports: [HealthModule, DocumentParserModule] })
export class PlatformModule {}
