import { Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AgentSession as PiAgentSession } from '@earendil-works/pi-coding-agent';
import { DeepseekLLMAdapter } from '../adapters/deepseek-llm.adapter';
import { SettingsService } from '../../settings/settings.service';
import {
  CLASSROOM_STUDENTS,
  createStudentSystemPrompt,
  isClassroomStudentId,
  type ClassroomStudentId,
} from '../../lessons/classroom-students';
import {
  MAX_POINT_TURNS,
  countPointTurns,
  countPointTurnsByStudent,
  normalizePointLabel,
  resolvePointTurn,
  selectNextQuestioner,
  type LessonPointState,
  type ResolvedPointTurn,
} from '../../lessons/lesson-point';
import type {
  ClassroomTurnResult,
  LessonMessage,
} from '../../lessons/lesson.types';
import {
  formatSpeakerSequence,
  formatTranscript,
} from '../../lessons/transcript-format';
import { LessonsService } from '../../lessons/lessons.service';
import { StudentAgent } from './StudentAgent';
import {
  createCleanPiSession,
  resolvePiAgentEnvironment,
  runPiTurn,
  type PiTurnOptions,
} from '../pi-agent-runtime';
import {
  CLASSROOM_SYSTEM_PROMPT,
  CLASSROOM_TRANSCRIPT_CHAR_LIMIT,
  CLASSROOM_TRANSCRIPT_MESSAGE_LIMIT,
  buildDirectorPrompt,
  buildNextPointQuestionPrompt,
  buildStudentPrompt,
  parseDirectorDecision,
  type DirectorDecision,
  type DirectorPointContext,
  type StudentPointContext,
} from '../prompts/classroom-simulation.prompt';
import { ClassroomTurnError, isLessonError } from '../turn-errors';

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

      const teacherMessage = await this.lessons.appendMessage(
        lesson.id,
        'teacher',
        prompt,
      );
      const lessonMessages = await this.lessons.readMessages(lesson.id);
      const transcript = formatTranscript(lessonMessages, {
        limit: CLASSROOM_TRANSCRIPT_MESSAGE_LIMIT,
        charLimit: CLASSROOM_TRANSCRIPT_CHAR_LIMIT,
      });
      const speakerSequence = formatSpeakerSequence(lessonMessages);
      const pointState: LessonPointState = {
        startMessageId: lesson.pointStartMessageId,
        label: lesson.pointLabel,
      };
      const currentTurns = countPointTurns(
        lessonMessages,
        pointState.startMessageId,
      );

      let studentId: ClassroomStudentId;
      let reply: string;
      let pointTurn: ResolvedPointTurn | undefined;
      let decision: DirectorDecision | undefined;
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
        const resolvedDecision = await this.selectNextStudent(
          directorSession,
          transcript,
          speakerSequence,
          {
            label: pointState.label,
            turns: currentTurns,
            maxTurns: MAX_POINT_TURNS,
          },
          {
            ...options,
            timeoutMs: options.timeoutMs ?? DIRECTOR_TIMEOUT_MS,
          },
        );
        decision = resolvedDecision;
        studentId = resolvedDecision.student as ClassroomStudentId;
        pointTurn = resolvePointTurn({
          state: pointState,
          messages: lessonMessages,
          teacherMessage,
          decision: resolvedDecision,
          maxTurns: MAX_POINT_TURNS,
        });
        this.logger.log({
          event: 'classroom.point.decision',
          requestId,
          lessonId: lesson.id,
          done: resolvedDecision.done,
          labelChanged: pointTurn.started,
          turns: pointTurn.turns,
          pointLabelChars: pointTurn.state.label
            ? Array.from(pointTurn.state.label).length
            : 0,
        });
        reply = await this.studentReply(
          studentId,
          transcript,
          requestId,
          {
            label: pointTurn.state.label,
            turns: pointTurn.turns,
            forceClose: pointTurn.forceClose,
            maxTurns: MAX_POINT_TURNS,
          },
          {
            ...options,
            timeoutMs: options.timeoutMs ?? STUDENT_TIMEOUT_MS,
          },
        );
      } catch (error) {
        throw isLessonError(error) ? error : new ClassroomTurnError(error);
      }

      const studentMessage = await this.lessons.appendMessage(
        lesson.id,
        studentId,
        reply,
      );
      // Persist the point state only after the student's line exists, so a failed turn cannot
      // mark a point closed (or started) without the reply it describes.
      let nextMessage: LessonMessage | undefined;
      if (pointTurn?.forceClose) {
        this.logger.log({
          event: 'classroom.point.closed',
          requestId,
          lessonId: lesson.id,
          pointTurns: pointTurn.turns,
        });
        const counts = countPointTurnsByStudent(
          [...lessonMessages, studentMessage],
          pointTurn.state.startMessageId,
        );
        const nextStudentId = selectNextQuestioner({
          directorChoice: decision?.nextStudent,
          closer: studentId,
          counts,
        });
        const nextTranscript = formatTranscript(
          [...lessonMessages, studentMessage],
          {
            limit: CLASSROOM_TRANSCRIPT_MESSAGE_LIMIT,
            charLimit: CLASSROOM_TRANSCRIPT_CHAR_LIMIT,
          },
        );
        try {
          const question = await this.nextPointQuestion(
            nextStudentId,
            nextTranscript,
            pointTurn.state.label,
            decision?.nextFocus ?? null,
            requestId,
            options,
          );
          nextMessage = await this.lessons.appendMessage(
            lesson.id,
            nextStudentId,
            question,
          );
          const label =
            normalizePointLabel(decision?.nextFocus) ??
            normalizePointLabel(question) ??
            pointTurn.state.label;
          await this.lessons.savePointState(lesson.id, {
            startMessageId: nextMessage.id,
            label,
          });
          this.logger.log({
            event: 'classroom.point.next_question',
            requestId,
            lessonId: lesson.id,
            studentId: nextStudentId,
            oldLabelChars: pointTurn.state.label
              ? Array.from(pointTurn.state.label).length
              : 0,
            newLabelChars: label ? Array.from(label).length : 0,
          });
        } catch (error) {
          // The closing line is already durable; a failed next question must not fail the turn.
          this.logger.error({
            event: 'classroom.point.next_question.failed',
            requestId,
            lessonId: lesson.id,
            studentId: nextStudentId,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      } else if (pointTurn?.started) {
        await this.lessons.savePointState(lesson.id, pointTurn.state);
        this.logger.log({
          event: 'classroom.point.started',
          requestId,
          lessonId: lesson.id,
          pointLabelChars: pointTurn.state.label
            ? Array.from(pointTurn.state.label).length
            : 0,
        });
      }
      const messages = [
        ...lessonMessages,
        studentMessage,
        ...(nextMessage ? [nextMessage] : []),
      ];

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

  /** Asks the director which student answers next and whether the point continues. */
  private async selectNextStudent(
    session: PiAgentSession,
    transcript: string,
    speakerSequence: string,
    point: DirectorPointContext,
    options: ClassroomSimulationOptions,
  ): Promise<DirectorDecision> {
    const text = await runPiTurn(
      session,
      buildDirectorPrompt(transcript, speakerSequence, point),
      options,
    );
    const decision = parseDirectorDecision(text);
    if (!isClassroomStudentId(decision.student)) {
      throw new Error(
        `Classroom director chose an unknown student: ${String(decision.student) || '(missing)'}.`,
      );
    }
    return decision;
  }

  /** Generates one student's reply from the same transcript the director saw. */
  private async studentReply(
    studentId: ClassroomStudentId,
    transcript: string,
    requestId: string,
    point: StudentPointContext,
    options: ClassroomSimulationOptions,
  ): Promise<string> {
    const student = CLASSROOM_STUDENTS[studentId];
    const agent = this.studentAgent.createAgent(
      createStudentSystemPrompt(student),
    );
    return agent.run(buildStudentPrompt(transcript, student.name, point), {
      requestId,
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    });
  }

  /** Generates the question that opens the next knowledge point after a close. */
  private async nextPointQuestion(
    studentId: ClassroomStudentId,
    transcript: string,
    oldLabel: string | null,
    nextFocus: string | null,
    requestId: string,
    options: ClassroomSimulationOptions,
  ): Promise<string> {
    const student = CLASSROOM_STUDENTS[studentId];
    const agent = this.studentAgent.createAgent(
      createStudentSystemPrompt(student),
    );
    return agent.run(
      buildNextPointQuestionPrompt({
        transcript,
        studentName: student.name,
        oldLabel,
        nextFocus,
      }),
      {
        requestId,
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? STUDENT_TIMEOUT_MS,
      },
    );
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
