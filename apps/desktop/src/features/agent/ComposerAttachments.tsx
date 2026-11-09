import { FileText, Paperclip, X } from '@phosphor-icons/react';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { describeFailure } from '../../api/backend-error';
import { hasDesktopBridge } from '../../types/desktop-bridge';
import {
  composerAttachmentStore,
  sentAttachmentStore,
  type SentAttachment,
} from './attachment-store';

/**
 * Shows the files picked for the message being written.
 *
 * A tag is the only attachment surface in the composer: the file is copied and parsed when the
 * message is sent, and the extracted text never reaches the textarea or the sent message.
 */
export function ComposerAttachmentChips() {
  const items = useSyncExternalStore(
    composerAttachmentStore.subscribe,
    composerAttachmentStore.getSnapshot,
    composerAttachmentStore.getSnapshot,
  );

  if (items.length === 0) return null;

  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5">
      {items.map((item) => (
        <span
          className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-full border border-stone-300 bg-white py-0.5 pl-2 pr-1 text-xs text-stone-700"
          key={item.id}
        >
          <FileText aria-hidden className="size-3.5 shrink-0 text-stone-500" />
          <span className="min-w-0 max-w-[12rem] truncate" title={item.name}>
            {item.name}
          </span>
          <button
            aria-label={`移除附件 ${item.name}`}
            className="rounded-full p-0.5 text-stone-500 transition hover:bg-stone-100 hover:text-stone-900"
            onClick={() => composerAttachmentStore.remove(item.id)}
            type="button"
          >
            <X aria-hidden className="size-3" />
          </button>
        </span>
      ))}
    </div>
  );
}

/**
 * Opens the native picker and turns each chosen file into a composer tag.
 *
 * Nothing is uploaded here: the backend copies the file into the conversation's session directory
 * when the message is sent, because a brand-new conversation has no id yet.
 */
export function AttachmentPickerButton({ disabled }: { disabled: boolean }) {
  const [isPicking, setIsPicking] = useState(false);
  const [pickerError, setPickerError] = useState<string | null>(null);

  const pick = useCallback(async (): Promise<void> => {
    setPickerError(null);
    if (!hasDesktopBridge()) {
      setPickerError('请通过 TeachForge 桌面应用添加附件。');
      return;
    }

    setIsPicking(true);
    try {
      const picked = await window.teachforge.pickImportFiles();
      for (const path of picked) {
        composerAttachmentStore.add(fileNameOf(path), path);
      }
    } catch (error) {
      setPickerError(describeFailure(error, '无法打开文件选择器，请重试。'));
    } finally {
      setIsPicking(false);
    }
  }, []);

  return (
    <div className="flex min-w-0 items-center gap-2">
      <button
        aria-label="添加附件"
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs text-stone-500 transition hover:bg-stone-100 hover:text-stone-900 disabled:cursor-not-allowed disabled:opacity-50"
        disabled={disabled || isPicking}
        onClick={() => void pick()}
        title="添加 PDF、Word、Markdown 或 TXT 文件"
        type="button"
      >
        <Paperclip aria-hidden className="size-3.5" />
        附件
      </button>
      {pickerError && (
        <span className="truncate text-xs text-rose-700" role="alert">
          {pickerError}
        </span>
      )}
    </div>
  );
}

/**
 * Shows which files were sent with one user message, attached to that message.
 *
 * Live turns record the tags when the adapter sends; restored history fills the same map from the
 * persisted message row, so the bubble looks identical after a restart.
 */
export function UserAttachmentChips({ messageId }: { messageId: string }) {
  const byMessageId = useSyncExternalStore(
    sentAttachmentStore.subscribe,
    sentAttachmentStore.getSnapshot,
    sentAttachmentStore.getSnapshot,
  );
  const attachments = byMessageId[messageId] as SentAttachment[] | undefined;
  if (!attachments || attachments.length === 0) return null;

  return (
    <div className="mb-2 flex flex-wrap justify-end gap-1.5">
      {attachments.map((attachment) => (
        <span
          className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-stone-300 bg-white px-2 py-0.5 text-xs text-stone-700"
          key={attachment.attachmentId}
        >
          <FileText aria-hidden className="size-3.5 shrink-0 text-stone-500" />
          <span className="truncate">{attachment.name}</span>
        </span>
      ))}
    </div>
  );
}

/** Reads the trailing file name from an absolute path with either separator. */
function fileNameOf(path: string): string {
  const segments = path.split(/[\\/]/u);
  return segments[segments.length - 1] || path;
}
