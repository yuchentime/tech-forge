import { Injectable, Logger } from '@nestjs/common';
import { join } from 'node:path';
import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';

/** Embedding model bundled with the backend; changing it requires re-embedding all chunks. */
export const EMBEDDING_MODEL_ID = 'bge-small-zh-v1.5';
/** Vector width of EMBEDDING_MODEL_ID; the model does not support dimension reduction. */
export const EMBEDDING_DIMENSION = 512;
/** Texts per forward pass; keeps memory flat without hurting throughput. */
const EMBED_BATCH_SIZE = 32;
/** Quantised weights, matching the 23 MB file shipped under `assets/models`. */
const MODEL_DTYPE = 'q8';

/** Loads a local ONNX feature-extraction pipeline; remote models are never fetched at runtime. */
async function loadPipeline(): Promise<FeatureExtractionPipeline> {
  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.localModelPath = join(__dirname, '../../assets/models');
  return pipeline('feature-extraction', EMBEDDING_MODEL_ID, { dtype: MODEL_DTYPE });
}

/**
 * Produces chunk and query embeddings with the bundled model.
 *
 * The pipeline is created once per process and reused: model load is ~150 ms and encoding is ~4 ms
 * per chunk, so per-call construction would dominate ingest time.
 */
@Injectable()
export class EmbeddingService {
  private readonly logger = new Logger(EmbeddingService.name);
  private pipelinePromise?: Promise<FeatureExtractionPipeline>;

  /** Model id and width that written vectors must carry. */
  readonly modelId = EMBEDDING_MODEL_ID;
  readonly dimension = EMBEDDING_DIMENSION;

  /** Embeds a batch of texts; returns L2-normalised vectors in input order. */
  async embed(texts: string[]): Promise<Float32Array[]> {
    if (texts.length === 0) return [];
    const extractor = await this.getPipeline();
    const vectors: Float32Array[] = [];
    for (let offset = 0; offset < texts.length; offset += EMBED_BATCH_SIZE) {
      const batch = texts.slice(offset, offset + EMBED_BATCH_SIZE);
      const output = await extractor(batch, { pooling: 'cls', normalize: true });
      const width = output.dims[output.dims.length - 1];
      const flat = output.data as Float32Array;
      for (let index = 0; index < batch.length; index += 1) {
        vectors.push(flat.slice(index * width, (index + 1) * width));
      }
    }
    return vectors;
  }

  /** Embeds one text, used for the query side of retrieval. */
  async embedOne(text: string): Promise<Float32Array> {
    const [vector] = await this.embed([text]);
    if (!vector) throw new Error('embedding 未返回向量');
    return vector;
  }

  /** Loads the model on demand and remembers the failure so callers degrade instead of retrying. */
  private getPipeline(): Promise<FeatureExtractionPipeline> {
    this.pipelinePromise ??= loadPipeline().catch((error: unknown) => {
      this.pipelinePromise = undefined;
      const message = error instanceof Error ? error.message : String(error);
      this.logger.warn(`embedding 模型加载失败：${message}`);
      throw error;
    });
    return this.pipelinePromise;
  }
}
