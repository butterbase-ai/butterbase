import { LanguagePicker, uiText, useUiLocale } from "../../i18n";
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { bb } from '@/console/lib/bb';
import { Button } from '@/console/components/ui/button';
import { Input } from '@/console/components/ui/input';
import { ArrowRight, Mail } from 'lucide-react';

export function Login() {
  useUiLocale();
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [step, setStep] = useState<'email' | 'code'>('email');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  async function sendLink() {
    setLoading(true);
    setError(null);
    try {
      await bb.auth.sendMagicLink(email);
      setStep('code');
    } catch (e: any) {
      setError(e?.message || uiText('Failed to send magic link'));
    } finally {
      setLoading(false);
    }
  }

  async function verify() {
    setLoading(true);
    setError(null);
    try {
      await bb.auth.verifyMagicLink(email, code);
      navigate('/', { replace: true });
    } catch (e: any) {
      setError(e?.message || uiText('Invalid or expired code'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="paper-grain grid h-screen grid-cols-1 bg-background md:grid-cols-[1fr_1.05fr]">
      <div className="fixed bottom-4 right-4 z-50 rounded bg-background p-1"><LanguagePicker /></div>
      {/* Left — editorial column */}
      <div className="relative hidden flex-col justify-between border-r border-border p-12 md:flex">
        <div className="flex items-baseline gap-1.5">
          <span className="font-display text-[22px] leading-none text-foreground">{uiText("butter")}</span>
          <span className="font-editorial italic text-[22px] leading-none text-butter">{uiText("support")}</span>
        </div>

        <div className="max-w-md">
          <p className="eyebrow mb-4">{uiText("Welcome")}</p>
          <h1 className="page-title">
            {uiText("A warmer place to ")}<em>{uiText("answer")}</em> {uiText(" your customers.")}</h1>
          <p className="mt-6 max-w-sm font-editorial italic text-[15px] text-muted-foreground">
            {uiText("Butter Support pairs your team with an AI co-pilot that drafts replies, surfaces patterns, and escalates with care.")}</p>
        </div>

        <div>
          <div className="rule-dotted mb-4" />
          <p className="font-editorial italic text-[13px] text-muted-foreground">
            {uiText("\"The work is in the conversation.\"")}</p>
          <p className="mt-2 eyebrow !text-[9px]">{uiText("v1 · paper edition")}</p>
        </div>
      </div>

      {/* Right — form */}
      <div className="flex items-center justify-center p-6 md:p-12">
        <div className="w-full max-w-sm">
          <div className="md:hidden mb-10 flex items-baseline gap-1.5">
            <span className="font-display text-[22px] leading-none text-foreground">{uiText("butter")}</span>
            <span className="font-editorial italic text-[22px] leading-none text-butter">{uiText("support")}</span>
          </div>

          <p className="eyebrow mb-3">{uiText("Magic link · passwordless")}</p>
          <h2 className="font-display text-[34px] leading-none tracking-tight text-foreground">
            {step === 'email' ? <>{uiText("Sign ")}<em className="font-editorial italic text-butter">{uiText("in")}</em></> : <>{uiText("Check your ")}<em className="font-editorial italic text-butter">{uiText("inbox")}</em></>}
          </h2>
          <p className="mt-3 font-editorial italic text-[14px] text-muted-foreground">
            {step === 'email'
              ? uiText("We'll email you a 6-digit code. No password to remember.")
              : <>{uiText("Code sent to ")}<span className="text-foreground">{email}</span></>}
          </p>

          <div className="mt-8 space-y-3">
            {step === 'email' ? (
              <>
                <label className="eyebrow !text-[10px] block">{uiText("Email address")}</label>
                <div className="relative">
                  <Mail className="pointer-events-none absolute left-3.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" strokeWidth={1.75} />
                  <Input
                    type="email"
                    placeholder={uiText("you@company.com")}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && email && sendLink()}
                    className="pl-10"
                  />
                </div>
                <Button onClick={sendLink} disabled={!email || loading} size="lg" className="w-full">
                  {loading ? uiText('Sending…') : <>{uiText("Send magic link ")}<ArrowRight className="h-4 w-4" /></>}
                </Button>
              </>
            ) : (
              <>
                <label className="eyebrow !text-[10px] block">{uiText("6-digit code")}</label>
                <Input
                  inputMode="numeric"
                  maxLength={6}
                  placeholder="123 456"
                  value={code}
                  onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                  onKeyDown={(e) => e.key === 'Enter' && code.length === 6 && verify()}
                  className="text-center font-mono text-2xl tracking-[0.5em] h-14 num"
                />
                <Button onClick={verify} disabled={code.length !== 6 || loading} size="lg" className="w-full">
                  {loading ? uiText('Verifying…') : <>{uiText("Verify and sign in ")}<ArrowRight className="h-4 w-4" /></>}
                </Button>
                <Button variant="ghost" onClick={() => setStep('email')} className="w-full">
                  {uiText("Use a different email")}</Button>
              </>
            )}
            {error && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3.5 py-2.5 text-xs text-destructive">
                {error}
              </div>
            )}
          </div>

          <div className="mt-10 flex items-center gap-3">
            <div className="rule-dotted flex-1" />
            <span className="eyebrow !text-[9px]">{uiText("Signed by Butterbase Auth")}</span>
            <div className="rule-dotted flex-1" />
          </div>
        </div>
      </div>
    </div>
  );
}
