// services/platform-events/index.ts
import type { FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { createPlatformEventBus, type PlatformEventBus } from './platform-event-bus.js';

declare module 'fastify' {
  interface FastifyInstance {
    platformEventBus: PlatformEventBus;
  }
}

export const platformEventsPlugin = fp(async (app: FastifyInstance) => {
  const bus = createPlatformEventBus({ logger: app.log });
  app.decorate('platformEventBus', bus);
});

export { createPlatformEventBus } from './platform-event-bus.js';
export type { PlatformEventBus, PlatformEventMap } from './platform-event-bus.js';
