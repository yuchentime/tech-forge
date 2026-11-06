import { Body, Controller, Post, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import type { ServerResponse } from 'node:http';
import { AgentPromptDto } from './dto/agent-prompt.dto';
import { AgentService } from './agent.service';
import { encodeAgentSseEvent } from './sse';

/** Converts validated Agent prompts into authenticated HTTP SSE responses. */
@Controller('agent')
export class AgentController {
  /** Injects the single-turn Agent use case for HTTP streaming. */
  constructor(private readonly agent: AgentService) {}

  /** Streams assistant text and aborts the underlying Pi session on disconnect. */
  @Post('stream')
  async stream(
    @Body() input: AgentPromptDto,
    @Res() reply: FastifyReply,
  ): Promise<void> {
    const response = reply.raw;
    const abortController = new AbortController();
    const onClose = (): void => {
      if (!response.writableEnded) abortController.abort();
    };

    reply.hijack();
    response.on('close', onClose);
    response.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    response.flushHeaders();

    // stream() 返回异步生成器；拿到 iterator 本身还没有取出文本，第一次 next() 才会启动它。
    const stream = this.agent.stream(input.prompt, abortController.signal);
    const iterator = stream[Symbol.asyncIterator]();

    try {
      while (!abortController.signal.aborted) {
        // 等待生成器交付下一段：item.value 是文本片段，item.done 表示生成器已结束。
        const item = await iterator.next();
        // 等待下一段期间也可能收到断开事件，因此拿到结果后再次检查取消状态。
        if (abortController.signal.aborted) break;
        if (item.done) break;

        // 每次 next() 取得一个片段后编码成 SSE 写给前端，再循环请求下一段。
        const written = await writeSseFrame(
          response,
          encodeAgentSseEvent({ event: 'delta', data: { text: item.value } }),
          abortController.signal,
        );
        if (!written) {
          abortController.abort();
          break;
        }
      }

      if (!abortController.signal.aborted) {
        const written = await writeSseFrame(
          response,
          encodeAgentSseEvent({
            event: 'done',
            data: { finishReason: 'stop' },
          }),
          abortController.signal,
        );
        if (written) response.end();
      }
    } catch (error) {
      if (!abortController.signal.aborted) {
        const written = await writeSseFrame(
          response,
          encodeAgentSseEvent({
            event: 'error',
            data: { message: getSafeErrorMessage(error) },
          }),
          abortController.signal,
        );
        if (written) response.end();
      }
    } finally {
      if (abortController.signal.aborted) {
        try {
          await iterator.return?.(undefined);
        } catch {
          // Cancellation cleanup must not leak an iterator error to Fastify.
        }
      }
      response.removeListener('close', onClose);
    }
  }
}

/** Writes a frame without accumulating an unbounded response buffer. */
function writeSseFrame(
  response: ServerResponse,
  frame: string,
  signal: AbortSignal,
): Promise<boolean> {
  if (signal.aborted || response.destroyed || response.writableEnded) {
    return Promise.resolve(false);
  }
  if (response.write(frame)) return Promise.resolve(true);

  return new Promise((resolve) => {
    const finish = (written: boolean): void => {
      response.removeListener('drain', onDrain);
      response.removeListener('close', onClose);
      signal.removeEventListener('abort', onAbort);
      resolve(written && !signal.aborted && !response.destroyed);
    };
    const onDrain = (): void => finish(true);
    const onClose = (): void => finish(false);
    const onAbort = (): void => finish(false);

    response.once('drain', onDrain);
    response.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted || response.destroyed) finish(false);
  });
}

/** Hides provider errors while keeping missing local configuration actionable. */
function getSafeErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.includes('DEEPSEEK_API_KEY')) {
    return '未配置 DeepSeek API 密钥，请配置后重启应用。';
  }
  return '模型请求失败，请检查模型配置和网络后重试。';
}
