import { useState, useRef } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { bb } from '@/console/lib/bb';
import { api } from '@/console/lib/api';
import { Button } from '@/console/components/ui/button';
import { Input } from '@/console/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/console/components/ui/card';
import { SettingsPage } from '@/console/components/SettingsPage';
import { Badge } from '@/console/components/ui/badge';
import type { DocsSource } from '@/console/lib/types';
import { timeAgo } from '@/console/lib/utils';
import { toast } from '@/console/components/ui/toast';
import { confirm } from '@/console/components/ui/confirm';

export function DocsSettings() {
  const qc = useQueryClient();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const { data: sources = [] } = useQuery({
    queryKey: ['docs_sources'],
    queryFn: async () => {
      const res: any = await bb.from('docs_sources').select('*').order('created_at', { ascending: false });
      return (Array.isArray(res?.data) ? res.data : Array.isArray(res) ? res : []) as DocsSource[];
    },
    refetchInterval: 5000,
  });

  async function ingestUrl() {
    setBusy(true);
    try {
      const normalized = /^https?:\/\//i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
      await api.ingestDocs({ url: normalized, source_kind: 'web', display_name: name || normalized });
      setUrl(''); setName('');
      qc.invalidateQueries({ queryKey: ['docs_sources'] });
      toast.success('Ingest started');
    } catch (e: any) {
      toast.error(e?.message || 'Ingest failed');
    } finally {
      setBusy(false);
    }
  }

  async function uploadFile(file: File) {
    setBusy(true);
    try {
      const u = await api.requestDocUploadUrl({
        filename: file.name,
        content_type: file.type || 'application/octet-stream',
        size_bytes: file.size,
      });
      await fetch(u.upload_url, { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } });
      await api.ingestDocs({ source_kind: 'file', display_name: file.name, object_id: u.object_id });
      qc.invalidateQueries({ queryKey: ['docs_sources'] });
      toast.success('File uploaded and queued for ingest');
    } catch (e: any) {
      toast.error(e?.message || 'Upload failed');
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function remove(source_id: string) {
    if (!(await confirm({ title: 'Delete docs source?', description: 'The source and all of its embeddings will be removed permanently.', confirmLabel: 'Delete', variant: 'destructive' }))) return;
    try {
      await api.deleteDocsSource({ source_id });
      qc.invalidateQueries({ queryKey: ['docs_sources'] });
      toast.success('Docs source deleted');
    } catch (e: any) {
      toast.error(e?.message || 'Delete failed');
    }
  }

  return (
    <SettingsPage
      label="Knowledge"
      title={<>Feed the agent your <em>docs</em></>}
      description="Crawl URLs or upload files. The agent uses these for grounded, cited answers."
    >
      <Card>
        <CardHeader><CardTitle>Add a URL</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <Input placeholder="Display name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          <Input placeholder="https://docs.yourcompany.com" value={url} onChange={(e) => setUrl(e.target.value)} />
          <Button onClick={ingestUrl} disabled={!url || busy}>{busy ? 'Ingesting…' : 'Ingest URL'}</Button>
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Upload a file</CardTitle></CardHeader>
        <CardContent>
          <label className="flex items-center justify-center gap-3 rounded-xl border border-dashed border-rule bg-paper-warm px-6 py-8 cursor-pointer hover:border-butter-300/60 hover:bg-butter-50 transition-colors">
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.txt,.md,.csv,.html,.docx,.xlsx,.pptx"
              onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadFile(f); }}
              className="hidden"
              disabled={busy}
            />
            <div className="text-center">
              <div className="font-display text-base">Drop a file</div>
              <div className="mt-1 font-mono text-[10px] uppercase tracking-[0.18em] text-muted-foreground">
                pdf · md · csv · docx · xlsx · pptx · html
              </div>
            </div>
          </label>
        </CardContent>
      </Card>

      <div>
        <div className="section-label mb-3">Sources · {sources.length}</div>
        <div className="rounded-2xl border border-rule-soft bg-paper-soft divide-y divide-[rgb(244_236_221/0.06)]">
          {sources.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-4 py-3">
              <div className="flex-1 text-sm min-w-0">
                <div className="font-medium truncate text-foreground">{s.display_name}</div>
                <div className="font-mono text-[10px] text-muted-foreground truncate">
                  {s.source_kind} · added {timeAgo(s.created_at)}
                </div>
              </div>
              <Badge variant={s.last_crawl_status === 'ready' ? 'green' : s.last_crawl_status === 'failed' ? 'red' : 'amber'}>
                {s.last_crawl_status || 'pending'}
              </Badge>
              <Button size="sm" variant="ghost" onClick={() => remove(s.id)}>Delete</Button>
            </div>
          ))}
          {sources.length === 0 && <div className="p-4 text-sm text-muted-foreground">No sources yet.</div>}
        </div>
      </div>
    </SettingsPage>
  );
}
