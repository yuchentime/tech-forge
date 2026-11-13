/** Drafts per lesson, kept outside React so leaving the stage does not drop typing. */
export interface ClassroomDraft {
  lecture: string;
  reply: string;
}

const drafts = new Map<string, ClassroomDraft>();

/** Returns the lesson's draft, defaulting to empty strings. */
export function getClassroomDraft(lessonId: string): ClassroomDraft {
  return drafts.get(lessonId) ?? { lecture: '', reply: '' };
}

/** Applies one field without disturbing the other. */
export function setClassroomDraft(
  lessonId: string,
  patch: Partial<ClassroomDraft>,
): void {
  drafts.set(lessonId, { ...getClassroomDraft(lessonId), ...patch });
}

/** Drops a lesson's draft after it is sent or ended. */
export function clearClassroomDraft(lessonId: string): void {
  drafts.delete(lessonId);
}
