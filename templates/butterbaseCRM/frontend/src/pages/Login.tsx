import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { z } from 'zod';
import { toast } from 'sonner';
import { bb } from '@/lib/butterbase';

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from '@/components/ui/form';

// ── Schemas ──────────────────────────────────────────────────────────────────

const signinSchema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

const signupSchema = z.object({
  email: z.string().email('Enter a valid email'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
  display_name: z.string().min(1, 'Display name is required'),
});

const verifySchema = z.object({
  code: z
    .string()
    .length(6, 'Code must be exactly 6 digits')
    .regex(/^\d{6}$/, 'Code must be 6 digits'),
});

const magicLinkSchema = z.object({
  email: z.string().email('Enter a valid email'),
});

type SigninValues = z.infer<typeof signinSchema>;
type SignupValues = z.infer<typeof signupSchema>;
type VerifyValues = z.infer<typeof verifySchema>;
type MagicLinkValues = z.infer<typeof magicLinkSchema>;

type Mode = 'signin' | 'signup' | 'verify' | 'magic' | 'magic-verify';

// ── Signin form ───────────────────────────────────────────────────────────────

function SigninForm({
  onSwitch,
  onMagicLink,
  onSuccess,
}: {
  onSwitch: () => void;
  onMagicLink: () => void;
  onSuccess: () => void;
}) {
  const form = useForm<SigninValues>({
    resolver: zodResolver(signinSchema),
    defaultValues: { email: '', password: '' },
  });

  async function onSubmit(values: SigninValues) {
    const { error } = await bb.auth.signIn({ email: values.email, password: values.password });
    if (error) {
      toast.error(error.message);
      return;
    }
    onSuccess();
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input type="email" placeholder="you@example.com" autoComplete="email" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Password</FormLabel>
              <FormControl>
                <Input
                  type="password"
                  placeholder="••••••••"
                  autoComplete="current-password"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? 'Signing in…' : 'Sign in'}
        </Button>
        <Button type="button" variant="outline" className="w-full" onClick={onMagicLink}>
          Email me a sign-in code
        </Button>
      </form>
      <p className="mt-4 text-center text-sm text-muted-foreground">
        Don&apos;t have an account?{' '}
        <button
          type="button"
          onClick={onSwitch}
          className="font-medium text-foreground underline underline-offset-4"
        >
          Sign up
        </button>
      </p>
    </Form>
  );
}

// ── Magic link request form ───────────────────────────────────────────────────

function MagicLinkForm({
  onBack,
  onSignup,
  onSent,
}: {
  onBack: () => void;
  onSignup: () => void;
  onSent: (email: string) => void;
}) {
  const form = useForm<MagicLinkValues>({
    resolver: zodResolver(magicLinkSchema),
    defaultValues: { email: '' },
  });

  async function onSubmit(values: MagicLinkValues) {
    const { error } = await bb.auth.sendMagicLink(values.email);
    if (error) {
      toast.error(error.message);
      return;
    }
    onSent(values.email);
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input type="email" placeholder="you@example.com" autoComplete="email" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? 'Sending…' : 'Send sign-in code'}
        </Button>
      </form>
      <div className="mt-4 space-y-2 text-center text-sm text-muted-foreground">
        <p>
          <button
            type="button"
            onClick={onBack}
            className="font-medium text-foreground underline underline-offset-4"
          >
            Use password instead
          </button>
        </p>
        <p>
          Don&apos;t have an account?{' '}
          <button
            type="button"
            onClick={onSignup}
            className="font-medium text-foreground underline underline-offset-4"
          >
            Sign up
          </button>
        </p>
      </div>
    </Form>
  );
}

// ── Magic link verify form ────────────────────────────────────────────────────

function MagicLinkVerifyForm({
  email,
  onSuccess,
}: {
  email: string;
  onSuccess: () => void;
}) {
  const form = useForm<VerifyValues>({
    resolver: zodResolver(verifySchema),
    defaultValues: { code: '' },
  });

  async function onSubmit(values: VerifyValues) {
    const { error } = await bb.auth.verifyMagicLink(email, values.code);
    if (error) {
      toast.error(error.message);
      return;
    }
    onSuccess();
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <p className="text-sm text-muted-foreground">
          We sent a 6-digit code to <span className="font-medium text-foreground">{email}</span>.
        </p>
        <FormField
          control={form.control}
          name="code"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Sign-in code</FormLabel>
              <FormControl>
                <Input
                  placeholder="123456"
                  maxLength={6}
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? 'Verifying…' : 'Sign in'}
        </Button>
      </form>
    </Form>
  );
}

// ── Signup form ───────────────────────────────────────────────────────────────

function SignupForm({
  onSwitch,
  onSuccess,
}: {
  onSwitch: () => void;
  onSuccess: (email: string, password: string) => void;
}) {
  const form = useForm<SignupValues>({
    resolver: zodResolver(signupSchema),
    defaultValues: { email: '', password: '', display_name: '' },
  });

  async function onSubmit(values: SignupValues) {
    const { error } = await bb.auth.signUp({
      email: values.email,
      password: values.password,
      metadata: { display_name: values.display_name },
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    onSuccess(values.email, values.password);
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <FormField
          control={form.control}
          name="display_name"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Display name</FormLabel>
              <FormControl>
                <Input placeholder="Your name" autoComplete="name" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="email"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Email</FormLabel>
              <FormControl>
                <Input type="email" placeholder="you@example.com" autoComplete="email" {...field} />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <FormField
          control={form.control}
          name="password"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Password</FormLabel>
              <FormControl>
                <Input
                  type="password"
                  placeholder="••••••••"
                  autoComplete="new-password"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? 'Creating account…' : 'Create account'}
        </Button>
      </form>
      <p className="mt-4 text-center text-sm text-muted-foreground">
        Already have an account?{' '}
        <button
          type="button"
          onClick={onSwitch}
          className="font-medium text-foreground underline underline-offset-4"
        >
          Sign in
        </button>
      </p>
    </Form>
  );
}

// ── Verify form ───────────────────────────────────────────────────────────────

function VerifyForm({
  email,
  password,
  onSuccess,
}: {
  email: string;
  password: string;
  onSuccess: () => void;
}) {
  const form = useForm<VerifyValues>({
    resolver: zodResolver(verifySchema),
    defaultValues: { code: '' },
  });

  async function onSubmit(values: VerifyValues) {
    const { error: verifyError } = await bb.auth.verifyEmail(email, values.code);
    if (verifyError) {
      toast.error(verifyError.message);
      return;
    }
    // Auto sign-in after email verification
    const { error: signInError } = await bb.auth.signIn({ email, password });
    if (signInError) {
      toast.error(signInError.message);
      return;
    }
    onSuccess();
  }

  return (
    <Form {...form}>
      <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
        <p className="text-sm text-muted-foreground">
          We sent a 6-digit code to <span className="font-medium text-foreground">{email}</span>.
        </p>
        <FormField
          control={form.control}
          name="code"
          render={({ field }) => (
            <FormItem>
              <FormLabel>Verification code</FormLabel>
              <FormControl>
                <Input
                  placeholder="123456"
                  maxLength={6}
                  autoComplete="one-time-code"
                  inputMode="numeric"
                  {...field}
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
        <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
          {form.formState.isSubmitting ? 'Verifying…' : 'Verify'}
        </Button>
      </form>
    </Form>
  );
}

// ── Main Login page ───────────────────────────────────────────────────────────

const PENDING_TOKEN_KEY = 'crm.pending_invite_token';

function postAuthDestination(): string {
  const pending = localStorage.getItem(PENDING_TOKEN_KEY);
  return pending ? `/invite/${pending}` : '/';
}

export default function Login() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [mode, setMode] = useState<Mode>('magic');
  // Stored in component state (not localStorage) for security
  const [pendingEmail, setPendingEmail] = useState('');
  const [pendingPassword, setPendingPassword] = useState('');
  const denied = params.get('denied') === '1';

  useEffect(() => {
    if (denied) {
      toast.error('Access denied', {
        description: "Your email isn't on this app's allowlist. Ask the workspace owner to add you.",
      });
      return;
    }
    bb.auth.getUser().then(({ data }) => {
      if (data) navigate(postAuthDestination(), { replace: true });
    });
  }, [navigate, denied]);

  function handleSignupSuccess(email: string, password: string) {
    setPendingEmail(email);
    setPendingPassword(password);
    setMode('verify');
  }

  function handleVerifySuccess() {
    navigate(postAuthDestination(), { replace: true });
  }

  const titles: Record<Mode, string> = {
    signin: 'Welcome back',
    signup: 'Create your account',
    verify: 'Check your email',
    magic: 'Sign in with a code',
    'magic-verify': 'Check your email',
  };

  const descriptions: Record<Mode, string> = {
    signin: 'Sign in to your CRM workspace',
    signup: 'Get started with ButterbaseCRM',
    verify: 'Enter the verification code we sent you',
    magic: "Enter your email and we'll send you a 6-digit sign-in code",
    'magic-verify': 'Enter the sign-in code we sent you',
  };

  return (
    <div className="grid min-h-screen place-items-center bg-muted/40 p-4">
      <Card className="w-full max-w-md shadow-lg">
        <CardHeader className="space-y-1">
          <CardTitle className="text-2xl">{titles[mode]}</CardTitle>
          <CardDescription>{descriptions[mode]}</CardDescription>
        </CardHeader>
        <CardContent>
          {mode === 'signin' && (
            <SigninForm
              onSwitch={() => setMode('signup')}
              onMagicLink={() => setMode('magic')}
              onSuccess={() => navigate(postAuthDestination(), { replace: true })}
            />
          )}
          {mode === 'signup' && (
            <SignupForm onSwitch={() => setMode('signin')} onSuccess={handleSignupSuccess} />
          )}
          {mode === 'verify' && (
            <VerifyForm
              email={pendingEmail}
              password={pendingPassword}
              onSuccess={handleVerifySuccess}
            />
          )}
          {mode === 'magic' && (
            <MagicLinkForm
              onBack={() => setMode('signin')}
              onSignup={() => setMode('signup')}
              onSent={(email) => {
                setPendingEmail(email);
                setMode('magic-verify');
              }}
            />
          )}
          {mode === 'magic-verify' && (
            <MagicLinkVerifyForm
              email={pendingEmail}
              onSuccess={() => navigate(postAuthDestination(), { replace: true })}
            />
          )}
        </CardContent>
        <CardFooter />
      </Card>
    </div>
  );
}
