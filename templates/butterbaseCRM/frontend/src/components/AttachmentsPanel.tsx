import { useRef, useState } from 'react';
import { formatDistanceToNowStrict } from 'date-fns';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Trash2, Download, Upload, Loader2 } from 'lucide-react';
import { ScrollArea } from '@/components/ui/scroll-area';
import { useAttachments, useCreateAttachment, useDeleteAttachment } from '@/hooks/useAttachments';
import { useDownloadUrl } from '@/lib/storage';
import { bb } from '@/lib/butterbase';
import type { EntityType } from '@/lib/types';

interface Props {
  entityType: EntityType;
  entityId: string;
}

function formatBytes(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function AttachmentsPanel({ entityType, entityId }: Props) {
  const { data: attachments } = useAttachments(entityType, entityId);
  const createMut = useCreateAttachment();
  const deleteMut = useDeleteAttachment();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [uploadingFile, setUploadingFile] = useState<File | null>(null);

  async function handleFileSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.currentTarget.files?.[0];
    if (!file) return;

    setUploadingFile(file);
    try {
      const result = await bb.storage.upload(file, file.name);
      if (result.error) throw result.error;

      const { objectId } = result.data!;
      await createMut.mutateAsync({
        entity_type: entityType,
        entity_id: entityId,
        object_id: objectId,
        filename: file.name,
        content_type: file.type || null,
        size_bytes: file.size,
      });
      toast.success('File uploaded');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setUploadingFile(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  }

  async function handleDelete(id: string) {
    try {
      await deleteMut.mutateAsync({ id, entity_type: entityType, entity_id: entityId });
      toast.success('Attachment deleted');
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to delete attachment');
    }
  }

  return (
    <div className="space-y-4">
      <Button onClick={() => fileInputRef.current?.click()} disabled={uploadingFile !== null} size="sm">
        {uploadingFile ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
        {uploadingFile ? `Uploading ${uploadingFile.name}...` : 'Upload file'}
      </Button>
      <input
        ref={fileInputRef}
        type="file"
        onChange={handleFileSelect}
        className="hidden"
        disabled={uploadingFile !== null}
      />

      {!attachments || attachments.length === 0 ? (
        <div className="rounded-lg border border-dashed p-8 text-center">
          <p className="text-sm text-muted-foreground">No attachments yet</p>
        </div>
      ) : (
        <ScrollArea className="h-96">
          <div className="space-y-2 pr-4">
            {attachments.map((att) => (
              <AttachmentRow key={att.id} attachment={att} onDelete={handleDelete} />
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}

function AttachmentRow({
  attachment,
  onDelete,
}: {
  attachment: { id: string; object_id: string; filename: string; size_bytes: number | null; created_at: string };
  onDelete: (id: string) => void;
}) {
  const { data: downloadUrl } = useDownloadUrl(attachment.object_id);

  return (
    <div className="flex items-center justify-between rounded-lg border p-3">
      <div className="flex-1">
        <p className="text-sm font-medium truncate">{attachment.filename}</p>
        <p className="text-xs text-muted-foreground">
          {formatBytes(attachment.size_bytes)} • {formatDistanceToNowStrict(new Date(attachment.created_at), { addSuffix: true })}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <button
          onClick={() => downloadUrl && window.open(downloadUrl, '_blank')}
          disabled={!downloadUrl}
          className="text-muted-foreground hover:text-foreground disabled:opacity-50"
        >
          <Download className="h-4 w-4" />
        </button>
        <button onClick={() => onDelete(attachment.id)} className="text-muted-foreground hover:text-destructive">
          <Trash2 className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
