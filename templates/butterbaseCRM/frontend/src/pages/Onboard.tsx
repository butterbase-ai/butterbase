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

// ── Helpers ───────────────────────────────────────────────────────────────────

function slugify(s: string) {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 50);
}

// ── Schema ────────────────────────────────────────────────────────────────────

const onboardSchema = z.object({
  name: z.string().min(1, 'Workspace name is required'),
  slug: z
    .string()
    .min(1, 'Slug is required')
    .max(50, 'Slug must be 50 characters or fewer')
    .regex(/^[a-z0-9-]+$/, 'Slug may only contain lowercase letters, numbers, and hyphens'),
});

type OnboardValues = z.infer<typeof onboardSchema>;

// ── Page ──────────────────────────────────────────────────────────────────────

export default function Onboard() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const form = useForm<OnboardValues>({
    resolver: zodResolver(onboardSchema),
    defaultValues: { name: '', slug: '' },
  });

  function handleNameBlur() {
    const name = form.getValues('name');
    const currentSlug = form.getValues('slug');
    // Only auto-derive if the user hasn't manually edited the slug
    if (!currentSlug || currentSlug === slugify(form.getValues('name').slice(0, -1))) {
      form.setValue('slug', slugify(name), { shouldValidate: true });
    }
  }

  async function onSubmit(values: OnboardValues) {
    const { data: user } = await bb.auth.getUser();
    if (!user) {
      navigate('/login', { replace: true });
      return;
    }

    // Insert workspace
    const { data: wsData, error: wsError } = await bb
      .from<Workspace>('workspaces')
      .insert({ name: values.name, slug: values.slug, owner_user_id: user.id })
      .select();

    if (wsError) {
      toast.error(wsError.message);
      return;
    }

    // Normalize array or single object
    const ws = Array.isArray(wsData) ? wsData[0] : wsData;
    if (!ws) {
      toast.error('Failed to create workspace. Please try again.');
      return;
    }

    const { data: memData, error: memberError } = await bb
      .from('memberships')
      .insert({ workspace_id: ws.id, user_id: user.id, role: 'owner' })
      .select();

    if (memberError) {
      toast.error(memberError.message);
      return;
    }

    const membership = Array.isArray(memData) ? memData[0] : memData;

    useWorkspaceStore.getState().setWorkspace(ws.id);

    queryClient.setQueryData(['memberships', undefined], membership ? [membership] : []);
    await queryClient.invalidateQueries({ queryKey: ['memberships'] });

    navigate('/companies', { replace: true });
  }

  return (
    <div className="grid min-h-screen place-items-center bg-muted/40 p-4">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl">Create your workspace</CardTitle>
          <CardDescription>
            Set up your CRM workspace to start managing companies, people, and deals.
          </CardDescription>
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
                        onBlur={() => {
                          field.onBlur();
                          handleNameBlur();
                        }}
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
                    <FormLabel>Workspace slug</FormLabel>
                    <FormControl>
                      <Input placeholder="acme-corp" {...field} />
                    </FormControl>
                    <FormDescription>
                      URL-friendly identifier. Lowercase letters, numbers, and hyphens only.
                    </FormDescription>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? 'Creating workspace…' : 'Create workspace'}
              </Button>
            </form>
          </Form>
        </CardContent>
      </Card>
    </div>
  );
}
