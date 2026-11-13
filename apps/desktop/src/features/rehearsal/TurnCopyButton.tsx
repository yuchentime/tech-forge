import { Check, Copy as CopyIcon } from '@phosphor-icons/react';
import { useEffect, useState } from 'react';
import { showToast } from '../agent/toast';
import type { RehearsalTurn } from './rehearsal-api';
import { assessmentLabel } from './rehearsal-ui-utils';

/**
 * Builds the plain-text block a copied turn produces.
 *
 * It mirrors the card's visible order — the question, the user's answer, then the assessment level
 * and its issues — so the clipboard copy is exactly what the reader sees, with no hidden fields.
 * The card's own "第 N 问" index is navigation chrome, so the question is labelled 提问 instead.
 */
export function turnCopyText(turn: RehearsalTurn): string {
  const sections = [`提问\n${turn.question}`];
  const answer = turn.answer?.trim();
  if (answer) sections.push(`你的回答\n${answer}`);
  if (turn.assessment) {
    const assessment = [
      assessmentLabel(turn.assessment.level),
      ...turn.assessment.issues.map((issue) => `- ${issue}`),
    ];
    sections.push(assessment.join('\n'));
  }
  return sections.join('\n\n');
}

/**
 * Copies one answered turn to the clipboard and swaps to a check mark while the copy is fresh.
 *
 * Shared by the live session and the report, whose turn cards show the same content. Uses the
 * Clipboard API directly: these views are not assistant-ui threads, so the message copy primitive
 * has no message to read. A refusal is told to the user instead of silently doing nothing.
 */
export function TurnCopyButton({ turn }: { turn: RehearsalTurn }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1_800);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = (): void => {
    const write = navigator.clipboard?.writeText(turnCopyText(turn));
    if (!write) {
      showToast('当前环境无法写入剪贴板。');
      return;
    }
    void write.then(
      () => setCopied(true),
      () => showToast('复制失败，请重试。'),
    );
  };

  const label = copied ? '已复制' : `复制第 ${turn.sequenceNo} 问的问答与评估`;
  return (
    <button
      aria-label={label}
      className="inline-flex items-center gap-1 rounded-lg p-1.5 text-xs text-ink-400 transition hover:bg-ink-100 hover:text-ink-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500/40"
      onClick={copy}
      title={copied ? '已复制' : '复制问题、回答与评估'}
      type="button"
    >
      {copied ? (
        <Check aria-hidden className="size-4 text-brand-600" weight="bold" />
      ) : (
        <CopyIcon aria-hidden className="size-4" />
      )}
    </button>
  );
}
