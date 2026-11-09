import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Logger,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { ArtifactsService } from './artifacts.service';
import type {
  ArtifactContentDto,
  ArtifactLocationDto,
  ArtifactSummaryDto,
} from './artifacts.dto';
import { ListArtifactsQueryDto } from './artifacts.dto';
import { getSafeErrorLogFields, writeStructuredEvent } from '../logging/structured-logger';

/** Exposes the read-only artifact API backing the chat artifact sidebar. */
@Controller()
export class ArtifactsController {
  private readonly logger = new Logger(ArtifactsController.name);

  /** Injects the artifact owner for listing, previewing and locating files. */
  constructor(private readonly artifacts: ArtifactsService) {}

  /** Lists one conversation's artifacts, optionally narrowed to a single turn. */
  @Get('conversations/:conversationId/artifacts')
  async list(
    @Param('conversationId', new ParseUUIDPipe({ version: '4' }))
    conversationId: string,
    @Query() query: ListArtifactsQueryDto,
  ): Promise<ArtifactSummaryDto[]> {
    const requestId = randomUUID();
    const startedAt = Date.now();
    try {
      const result = await this.artifacts.listArtifacts(conversationId, {
        ...(query.userMessageId ? { userMessageId: query.userMessageId } : {}),
      });
      writeStructuredEvent(this.logger, 'log', 'artifacts.http.list.completed', {
        requestId,
        conversationId,
        artifactCount: result.length,
        elapsedMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      writeStructuredEvent(this.logger, 'error', 'artifacts.http.list.failed', {
        requestId,
        conversationId,
        elapsedMs: Date.now() - startedAt,
        ...getSafeErrorLogFields(error),
      });
      throw error;
    }
  }

  /** Returns the bounded preview text of one artifact. */
  @Get('artifacts/:artifactId/content')
  readContent(
    @Param('artifactId', new ParseUUIDPipe({ version: '4' })) artifactId: string,
  ): Promise<ArtifactContentDto> {
    return this.artifacts.readContent(artifactId);
  }

  /** Returns the directory holding one artifact so the shell can reveal it. */
  @Get('artifacts/:artifactId/location')
  getLocation(
    @Param('artifactId', new ParseUUIDPipe({ version: '4' })) artifactId: string,
  ): Promise<ArtifactLocationDto> {
    return this.artifacts.getLocation(artifactId);
  }

  /** Drops one artifact index row; the file on disk is left alone. */
  @Delete('artifacts/:artifactId')
  @HttpCode(HttpStatus.OK)
  remove(
    @Param('artifactId', new ParseUUIDPipe({ version: '4' })) artifactId: string,
  ): Promise<{ artifactId: string }> {
    return this.artifacts.removeArtifact(artifactId);
  }
}
