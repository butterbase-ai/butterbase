import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { bb } from '@/lib/butterbase';
import { useWorkspaceStore } from '@/lib/workspace';
import type { Workspace } from '@/lib/types';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Form,
  FormControl,
  FormDescription,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';

function slugify(s: string) {
  return s.toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
}

const schema = z.object({
  name: z.string().min(1, 'Workspace name is required'),
  slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, 'Lowercase letters, numbers, and hyphens only'),
});

type V = z.infer<typeof schema>;

export default function AgentOnboarding() {
  const navigate = useNavigate();
  const qc = useQueryClient();

  const form = useForm<V>({ resolver: zodResolver(schema), defaultValues: { name: '', slug: '' } });

  function handleNameBlur() {
    const name = form.getValues('name');
    const currentSlug = form.getValues('slug');
    if (!currentSlug || currentSlug === slugify(form.getValues('name').slice(0, -1))) {
      form.setValue('slug', slugify(name), { shouldValidate: true });
    }
  }

  async function onSubmit(values: V) {
    const { data: user } = await bb.auth.getUser();
    if (!user) { navigate('/login', { replace: true }); return; }
    const uid = (user as any).id ?? (user as any).user?.id;
    if (!uid) { toast.error('No user id'); return; }

    const { data: wsData, error: wsError } = await bb
      .from<Workspace>('workspaces')
      .insert({ name: values.name, slug: values.slug, owner_user_id: uid })
      .select();
    if (wsError) { toast.error(wsError.message); return; }
    const ws = Array.isArray(wsData) ? wsData[0] : wsData;
    if (!ws) { toast.error('Failed to create workspace'); return; }

    const { data: memData, error: memErr } = await bb
      .from('memberships' as any)
      .insert({ workspace_id: ws.id, user_id: uid, role: 'owner' })
      .select();
    if (memErr) { toast.error(memErr.message); return; }

    useWorkspaceStore.getState().setWorkspace(ws.id);
    qc.setQueryData(['memberships', undefined], Array.isArray(memData) ? memData : memData ? [memData] : []);
    await qc.invalidateQueries({ queryKey: ['memberships'] });

    navigate('/settings', { replace: true });
  }

  return (
    <div className="grid min-h-screen place-items-center bg-muted/40 p-4">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl">Create your workspace</CardTitle>
          <CardDescription>Name it to get started.</CardDescription>
        </CardHeader>
        <CardContent>
          <Form {...form}>
            <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
              <FormField
                control={form.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Workspace name</FormLabel>
                    <FormControl>
                      <Input
                        placeholder="Acme Corp"
                        {...field}
                        onBlur={() => { field.onBlur(); handleNameBlur(); }}
                      />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={form.control}
                name="slug"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>Slug</FormLabel>
                    <FormControl><Input placeholder="acme-corp" {...field} /></FormControl>
                    <FormDescription>URL-friendly identifier.</FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? 'Creating…' : 'Create workspace'}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
