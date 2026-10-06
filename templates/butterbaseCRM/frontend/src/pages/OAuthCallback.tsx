import { useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { bb } from '@/lib/butterbase';
import { toast } from 'sonner';

export default function OAuthCallback() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const { toolkit } = useParams<{ toolkit?: string }>();

  useEffect(() => {
    // Toolkit comes from the path segment (/auth/callback/integration/:toolkit)
    // so it can't be polluted by post-OAuth query params the relay appends.
    // Fall back to the legacy ?integration= form for older redirect URLs still in flight.
    const integration = toolkit ?? params.get('integration');

    // Integration return (e.g. Gmail) — bounce into Settings with status flags.
    if (integration) {
      const status = params.get('error') ? 'error' : 'success';
      const next = new URLSearchParams();
      next.set('integration', integration);
      next.set('integration_status', status);
      const err = params.get('error_description') ?? params.get('error');
      if (err) next.set('integration_error', err);
      navigate(`/settings?${next.toString()}`, { replace: true });
      return;
    }

    // Auth (sign-in) return.
    (async () => {
      const { error } = await bb.auth.handleOAuthCallback();
      if (error) {
        toast.error(`Sign-in failed: ${error.message}`);
        navigate('/login', { replace: true });
        return;
      }
      navigate('/', { replace: true });
    })();
  }, [navigate, params, toolkit]);

  return (
    <div className="paper-grain grid min-h-screen place-items-center bg-background">
      <div className="text-center">
        <div className="mx-auto mb-4 h-8 w-8 rounded-full border-2 border-butter/30 border-t-butter animate-spin" />
        <p className="font-editorial italic text-[15px] text-muted-foreground">
          Finishing the handshake…
        </p>
      </div>
    </div>
  );
}
