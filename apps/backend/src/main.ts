import 'reflect-metadata';
import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import type { FastifyInstance } from 'fastify';
import { AppModule } from './app.module';
import { migrateLegacyDataDirectory } from './platform/local-paths';

const READY_PREFIX = 'TEACHFORGE_BACKEND_READY=';
let nestApp: NestFastifyApplication | undefined;

async function bootstrap(): Promise<void> {
  // Must run before any provider opens the database: older builds kept it under Electron userData.
  const migratedDataDirectory = migrateLegacyDataDirectory(
    process.env.TEACHFORGE_LEGACY_DATA_DIR,
  );
  if (migratedDataDirectory) {
    process.stdout.write(`TEACHFORGE_DATA_MIGRATED=${migratedDataDirectory}\n`);
  }

  const token = process.env.TEACHFORGE_AUTH_TOKEN;
  if (!token) {
    throw new Error('TEACHFORGE_AUTH_TOKEN must be set before starting the backend.');
  }

  const host = '127.0.0.1';
  const port = Number(process.env.TEACHFORGE_PORT ?? '0');
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new Error('TEACHFORGE_PORT must be an integer between 0 and 65535.');
  }

  nestApp = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: 1_048_576 }),
  );

  nestApp.setGlobalPrefix('api');
  nestApp.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  nestApp.enableShutdownHooks();

  const fastify = nestApp.getHttpAdapter().getInstance() as FastifyInstance;
  fastify.addHook('onRequest', async (request, reply) => {
    if (request.headers.origin) {
      reply.code(403).send({ statusCode: 403, message: 'Origin is not allowed.' });
      return;
    }

    if (request.headers['x-teachforge-token'] !== token) {
      reply.code(401).send({ statusCode: 401, message: 'Unauthorized.' });
      return;
    }
  });

  await nestApp.listen(port, host);
  const address = nestApp.getHttpServer().address();
  if (!address || typeof address === 'string') {
    throw new Error('Backend did not bind to a TCP port.');
  }

  process.stdout.write(`${READY_PREFIX}${JSON.stringify({ port: address.port })}\n`);
}

bootstrap().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`TeachForge backend failed to start: ${message}\n`);
  const closeApp = nestApp?.close();
  if (closeApp) {
    void closeApp.catch(() => undefined).finally(() => {
      process.exitCode = 1;
    });
  } else {
    process.exitCode = 1;
  }
});
