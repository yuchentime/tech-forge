import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

/** Boundary input for importing one local file into the knowledge library. */
export class ImportDocumentDto {
  /** Absolute path to a supported file; the renderer never sends file bytes. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(4096)
  filePath!: string;

  /** Optional display title; defaults to the file name without its extension. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  title?: string;
}
