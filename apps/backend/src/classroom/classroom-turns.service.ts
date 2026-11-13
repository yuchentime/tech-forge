import { Injectable } from '@nestjs/common';
import type { ClassroomTurnResult } from '../lessons/lesson.types';
import type { ClassroomSimulationOptions } from '../llm/agents/ClassroomSimulationAgent';
import { ClassroomSimulationAgent } from '../llm/agents/ClassroomSimulationAgent';

/** Raised when a second turn is submitted while one is still running for the same lesson. */
export class LessonTurnBusyError extends Error {
  constructor(lessonId: string) {
    super(`Lesson turn is already running: ${lessonId}.`);
    this.name = 'LessonTurnBusyError';
  }
}

/**
 * Serializes classroom turns per lesson.
 *
 * `appendMessage()` already serializes writes, but a whole turn is read → two model calls → write;
 * two overlapping turns would both read the same transcript and answer out of order. This lock
 * rejects the second request instead of queueing it, so the UI can say "这一轮还没结束".
 */
@Injectable()
export class ClassroomTurnsService {
  private readonly running = new Set<string>();

  constructor(private readonly agent: ClassroomSimulationAgent) {}

  /** Whether one lesson already has a turn in progress. */
  isRunning(lessonId: string): boolean {
    return this.running.has(lessonId);
  }

  /** Runs one teacher turn; locks the lesson while it runs. */
  async runTurn(
    lessonId: string,
    text: string,
    options: ClassroomSimulationOptions = {},
  ): Promise<ClassroomTurnResult> {
    if (this.running.has(lessonId)) {
      throw new LessonTurnBusyError(lessonId);
    }
    this.running.add(lessonId);
    try {
      return await this.agent.run(text, { ...options, lessonId });
    } finally {
      this.running.delete(lessonId);
    }
  }
}
