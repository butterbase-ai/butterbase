import fp from 'fastify-plugin';
import websocket from '@fastify/websocket';
import { RealtimeManager } from '../services/realtime-manager.js';

declare module 'fastify' {
  interface FastifyInstance {
    realtimeManager: RealtimeManager;
  }
}

export const realtimePlugin = fp(
  async (app) => {
    // Register @fastify/websocket
    await app.register(websocket);

    // Create and decorate the RealtimeManager
    const manager = new RealtimeManager(app.controlDb, {
      info: (...args: unknown[]) => app.log.info(args[0] as object, args[1] as string ?? ''),
      warn: (...args: unknown[]) => app.log.warn(args[0] as object, args[1] as string ?? ''),
      error: (...args: unknown[]) => app.log.error(args[0] as object, args[1] as string ?? ''),
    });
    app.decorate('realtimeManager', manager);

    // Start background timers after the server is ready
    app.addHook('onReady', async () => {
      manager.start();
      app.log.info('[Realtime] Manager started');
    });

    // Graceful shutdown
    app.addHook('onClose', async () => {
      await manager.shutdown();
      app.log.info('[Realtime] Manager shut down');
    });
  },
  { name: 'realtime', dependencies: ['database', 'data-plane'] }
);
