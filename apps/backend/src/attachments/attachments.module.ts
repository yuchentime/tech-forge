import { Module } from '@nestjs/common';
import { DocumentParserModule } from '../platform/document-parser/document-parser.module';
import { SettingsModule } from '../settings/settings.module';
import { AttachmentsService } from './attachments.service';

/**
 * Registers chat attachments: the per-conversation copy and the extracted text.
 *
 * No controller: nothing is uploaded at pick time, so the only entry point is the chat turn itself.
 * The parser is the platform adapter shared with the knowledge library; this module owns no index.
 */
@Module({
  imports: [DocumentParserModule, SettingsModule],
  providers: [AttachmentsService],
  exports: [AttachmentsService],
})
export class AttachmentsModule {}
