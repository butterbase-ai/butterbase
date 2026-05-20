// services/control-api/src/routes/auth/index.ts
import type { FastifyInstance } from 'fastify';
import { signupRoutes } from './signup.js';
import { loginRoutes } from './login.js';
import { refreshRoutes } from './refresh.js';
import { logoutRoutes } from './logout.js';
import { oauthRoutes } from './oauth.js';
import { jwksRoutes } from './jwks.js';
import { verifyEmailRoutes } from './verify-email.js';
import { forgotPasswordRoutes } from './forgot-password.js';
import { resetPasswordRoutes } from './reset-password.js';
import { meRoutes } from './me.js';
import { magicLinkRoutes } from './magic-link.js';
import { adminAuthUsersRoutes } from './admin-users.js';

export async function authRoutes(app: FastifyInstance) {
  await app.register(signupRoutes);
  await app.register(loginRoutes);
  await app.register(refreshRoutes);
  await app.register(logoutRoutes);
  await app.register(oauthRoutes);
  await app.register(jwksRoutes);
  await app.register(verifyEmailRoutes);
  await app.register(forgotPasswordRoutes);
  await app.register(resetPasswordRoutes);
  await app.register(meRoutes);
  await app.register(magicLinkRoutes);
  await app.register(adminAuthUsersRoutes);
}
