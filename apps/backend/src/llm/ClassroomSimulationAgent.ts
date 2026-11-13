import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AgentSession as PiAgentSession } from '@earendil-works/pi-coding-agent';
import { DeepseekLLMAdapter } from './adapters/deepseek-llm.adapter';
import { SettingsService } from '../settings/settings.service';
import {
  CLASSROOM_STUDENTS,
  createStudentSystemPrompt,
  isClassroomStudentId,
  type ClassroomStudentId,
} from '../lessons/classroom-students';
import type { ClassroomTurnResult } from '../lessons/lesson.types';
import {
  formatSpeakerSequence,
  formatTranscript,
} from '../lessons/transcript-format';
import { LessonsService } from '../lessons/lessons.service';
import { StudentAgent } from './StudentAgent';
import {
  createCleanPiSession,
  resolvePiAgentEnvironment,
  runPiTurn,
  type PiTurnOptions,
} from './pi-agent-runtime';
import {
  CLASSROOM_SYSTEM_PROMPT,
  CLASSROOM_TRANSCRIPT_CHAR_LIMIT,
  CLASSROOM_TRANSCRIPT_MESSAGE_LIMIT,
  buildDirectorPrompt,
  buildStudentPrompt,
  parseDirectorSelection,
} from './classroom-simulation.prompt';
import { ClassroomTurnError, isLessonError } from './turn-errors';

/** Director picks one student; it must never hang the turn (and the lesson lock) forever. */
const DIRECTOR_TIMEOUT_MS = 60_000;
/** Student writes one or two sentences; a longer budget than the director but still bounded. */
const STUDENT_TIMEOUT_MS = 120_000;

/** Request-scoped options for one classroom turn. */
export interface ClassroomSimulationOptions extends PiTurnOptions {
  requestId?: string;
  /** Continues an existing lesson; when omitted, the active lesson is closed and replaced. */
  lessonId?: string;
}

/**
 * Runs one classroom turn: persist the teacher's text, let the director pick a student, let that
 * student answer, persist the answer, and return the transcript.
 *
 * The agent keeps no message state of its own: the lesson row lives in SQLite, the transcript in
 * `<configDir>/lessons/<lessonId>/messages.jsonl`, and every turn reads it back. That keeps the
 * service safe to share across concurrent lessons and across process restarts.
 */
@Injectable()
export class ClassroomSimulationAgent {
  private readonly logger = new Logger(ClassroomSimulationAgent.name);

  constructor(
    private readonly deepseekAdapter: DeepseekLLMAdapter,
    private readonly settings: SettingsService,
    private readonly studentAgent: StudentAgent,
    private readonly lessons: LessonsService,
  ) {}

  /**
   * Turns one teacher utterance into a single student response.
   *
   * A missing `lessonId` replaces the active lesson with a new one. The teacher's text is appended
   * before any provider call, so a failed turn never drops what the user typed; the student's text
   * is appended only after it succeeded. Throws when the lesson is ended, the model output is not a
   * valid student selection, the provider rejects the request, or the call is cancelled.
   */
  async run(
    teacherMessage: string,
    options: ClassroomSimulationOptions = {},
  ): Promise<ClassroomTurnResult> {
    const prompt = teacherMessage.trim();
    if (!prompt) {
      throw new Error(
        'Classroom simulation requires a non-empty teacher message.',
      );
    }

    const requestId = options.requestId ?? randomUUID();
    const startedAt = Date.now();
    let outcome: 'completed' | 'failed' | 'cancelled' = 'failed';
    let lessonId = options.lessonId;
    let session: PiAgentSession | undefined;

    this.logger.log({
      event: 'classroom.turn.started',
      requestId,
      lessonId: lessonId ?? null,
      promptLength: Array.from(prompt).length,
    });

    try {
      const lesson = lessonId
        ? await this.lessons.requireActiveLesson(lessonId)
        : await this.lessons.startNewLesson();
      lessonId = lesson.id;

      await this.lessons.appendMessage(lesson.id, 'teacher', prompt);
      const lessonMessages = await this.lessons.readMessages(lesson.id);
      const transcript = formatTranscript(lessonMessages, {
        limit: CLASSROOM_TRANSCRIPT_MESSAGE_LIMIT,
        charLimit: CLASSROOM_TRANSCRIPT_CHAR_LIMIT,
      });
      const speakerSequence = formatSpeakerSequence(lessonMessages);

      let studentId: ClassroomStudentId;
      let reply: string;
      try {
        const environment = await resolvePiAgentEnvironment(
          this.deepseekAdapter,
          this.settings,
        );
        session = await createCleanPiSession(
          environment,
          CLASSROOM_SYSTEM_PROMPT,
          'off',
        );
        const directorSession = session;
        studentId = await this.selectNextStudent(
          directorSession,
          transcript,
          speakerSequence,
          {
            ...options,
            timeoutMs: options.timeoutMs ?? DIRECTOR_TIMEOUT_MS,
          },
        );
        reply = await this.studentReply(studentId, transcript, requestId, {
          ...options,
          timeoutMs: options.timeoutMs ?? STUDENT_TIMEOUT_MS,
        });
      } catch (error) {
        throw isLessonError(error) ? error : new ClassroomTurnError(error);
      }

      const studentMessage = await this.lessons.appendMessage(
        lesson.id,
        studentId,
        reply,
      );
      const messages = [...lessonMessages, studentMessage];

      outcome = 'completed';
      this.logger.log({
        event: 'classroom.turn.completed',
        requestId,
        lessonId: lesson.id,
        studentId,
        messageCount: messages.length,
        elapsedMs: Date.now() - startedAt,
      });
      return { lessonId: lesson.id, messages };
    } catch (error) {
      outcome = options.signal?.aborted ? 'cancelled' : 'failed';
      this.logger.error({
        event: 'classroom.turn.failed',
        requestId,
        lessonId: lessonId ?? null,
        elapsedMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    } finally {
      this.disposeSession(session, requestId);
      this.logger.log({
        event: 'classroom.turn.terminated',
        requestId,
        lessonId: lessonId ?? null,
        outcome,
        elapsedMs: Date.now() - startedAt,
      });
    }
  }

  /** Asks the director which student answers next and validates its JSON selection. */
  private async selectNextStudent(
    session: PiAgentSession,
    transcript: string,
    speakerSequence: string,
    options: ClassroomSimulationOptions,
  ): Promise<ClassroomStudentId> {
    const text = await runPiTurn(
      session,
      buildDirectorPrompt(transcript, speakerSequence),
      options,
    );
    const value = parseDirectorSelection(text);
    if (!isClassroomStudentId(value)) {
      throw new Error(
        `Classroom director chose an unknown student: ${String(value) || '(missing)'}.`,
      );
    }
    return value;
  }

  /** Generates one student's reply from the same transcript the director saw. */
  private async studentReply(
    studentId: ClassroomStudentId,
    transcript: string,
    requestId: string,
    options: ClassroomSimulationOptions,
  ): Promise<string> {
    const student = CLASSROOM_STUDENTS[studentId];
    const agent = this.studentAgent.createAgent(
      createStudentSystemPrompt(student),
    );
    return agent.run(buildStudentPrompt(transcript, student.name), {
      requestId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  }

  /** Disposes one session without letting a cleanup failure mask the turn's own result. */
  private disposeSession(
    session: PiAgentSession | undefined,
    requestId: string,
  ): void {
    if (!session) return;
    try {
      session.dispose();
    } catch (error) {
      this.logger.error({
        event: 'classroom.turn.dispose.failed',
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
