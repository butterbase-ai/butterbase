import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Toaster } from '@/components/ui/sonner';
import { AppRoutes } from './routes';
import { useRealtimeInvalidation } from './lib/realtime';
import { SupportWidget } from './lib/supportWidget';

const qc = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 30_000, refetchOnWindowFocus: false, retry: 1 },
  },
});

function RealtimeBoot() {
  useRealtimeInvalidation();
  return null;
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <RealtimeBoot />
        <AppRoutes />
        <SupportWidget />
        <Toaster />
      </BrowserRouter>
    </QueryClientProvider>
  );
}
