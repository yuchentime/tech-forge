/**
 * Local state of one classroom session.
 *
 * It deliberately lives outside the classroom view so temporarily leaving the stage (the top-left
 * exit or `Esc`) does not throw the lesson away; ending a classroom calls `reset()`. Nothing is
 * persisted yet — the session is gone after the application restarts — until the classroom flow is
 * wired to the conversation and its record storage.
 */

export type ClassroomPhase = 'composing' | 'sent';

export type ClassroomMessageRole = 'teacher' | 'student';

export interface ClassroomMessage {
  id: string;
  role: ClassroomMessageRole;
  label: string;
  text: string;
}

export interface ClassroomSessionSnapshot {
  phase: ClassroomPhase;
  /** Text in the four-line lecture box while composing. */
  lectureDraft: string;
  /** Lecture moved onto the desk; the full text lives in the message sidebar. */
  lecture: string;
  /** Text in the single-line reply box while answering. */
  reply: string;
  messages: readonly ClassroomMessage[];
  /** Whether a student question bubble is currently shown. */
  isQuestionVisible: boolean;
}

/** The student question shown in the MVP; replaced by generated questions later. */
export const CLASSROOM_STUDENT = {
  name: '小满',
  question: '老师，缓存雪崩到底是从哪一步开始崩的？',
} as const;

const INITIAL_SNAPSHOT: ClassroomSessionSnapshot = {
  phase: 'composing',
  lectureDraft: '',
  lecture: '',
  reply: '',
  messages: [],
  isQuestionVisible: false,
};

/** Shares the classroom session between the stage and whichever view temporarily replaces it. */
export class ClassroomSessionStore {
  private readonly listeners = new Set<() => void>();
  private messageSequence = 0;
  private snapshot: ClassroomSessionSnapshot = INITIAL_SNAPSHOT;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): ClassroomSessionSnapshot => this.snapshot;

  /** Replaces the snapshot and notifies subscribers; callers never mutate it in place. */
  private update(patch: Partial<ClassroomSessionSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const listener of this.listeners) listener();
  }

  /** Keeps the lecture draft while its box is on screen. */
  setLectureDraft(value: string): void {
    if (this.snapshot.phase !== 'composing') return;
    this.update({ lectureDraft: value });
  }

  /** Keeps the reply draft while the single-line box is on screen. */
  setReply(value: string): void {
    if (this.snapshot.phase !== 'sent') return;
    this.update({ reply: value });
  }

  /**
   * Moves the lecture onto the desk and shows the first student question.
   *
   * Returns false for an empty draft so the caller can skip its send feedback.
   */
  sendLecture(): boolean {
    const text = this.snapshot.lectureDraft.trim();
    if (!text) return false;
    this.update({
      phase: 'sent',
      lectureDraft: '',
      lecture: text,
      isQuestionVisible: true,
      messages: [
        { id: this.nextMessageId(), role: 'teacher', label: '老师 · 讲稿', text },
        {
          id: this.nextMessageId(),
          role: 'student',
          label: CLASSROOM_STUDENT.name,
          text: CLASSROOM_STUDENT.question,
        },
      ],
    });
    return true;
  }

  /** Appends the answer and dismisses the question bubble; returns false for an empty reply. */
  sendReply(): boolean {
    const text = this.snapshot.reply.trim();
    if (!text) return false;
    this.update({
      reply: '',
      isQuestionVisible: false,
      messages: [
        ...this.snapshot.messages,
        { id: this.nextMessageId(), role: 'teacher', label: '老师', text },
      ],
    });
    return true;
  }

  /** Clears the round for "重新讲解": same classroom, fresh lesson. */
  reset(): void {
    this.snapshot = INITIAL_SNAPSHOT;
    for (const listener of this.listeners) listener();
  }

  private nextMessageId(): string {
    this.messageSequence += 1;
    return `classroom-message-${this.messageSequence}`;
  }
}

export const classroomSessionStore = new ClassroomSessionStore();
