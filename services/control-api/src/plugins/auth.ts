import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { ApiKeyService } from '../services/api-key-service.js';
import type { AuthContext } from '@butterbase/shared/types';
import type { AuthProvider } from '../services/auth-provider.js';
import { LocalAuthProvider } from '../services/local-auth-provider.js';
import { CognitoAuthProvider } from '../services/cognito-auth-provider.js';
import { config } from '../config.js';
import { createAgentError, getDocUrl } from '../services/error-handler.js';
// Stripe provisioning lives in the cloud overlay; in OSS mode it's a no-op.
async function provisionStripeCustomer(
  ...args: [unknown, string, string]
): Promise<void> {
  try {
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore — overlay path resolved at runtime; absent in OSS mode
    const mod = await import('../../../../cloud-overlays/dist/cloud-overlays/billing/stripe/stripe-provisioning.js');
    await mod.provisionStripeCustomer(...args);
  } catch {
    // OSS mode: no Stripe.
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }

  interface FastifyContextConfig {
    public?: boolean;
  }
}

const authPlugin: FastifyPluginAsync = async (fastify) => {
  // Initialize auth provider based on environment
  const authProvider: AuthProvider = config.cognito.userPoolId
    ? new CognitoAuthProvider(
        config.cognito.userPoolId,
        config.cognito.clientId,
        config.cognito.region
      )
    : new LocalAuthProvider(config.auth.jwtSecret);

  fastify.addHook('onRequest', async (request, reply) => {
    // Skip auth for public routes
    if (request.routeOptions.config?.public) {
      return;
    }

    // E2E test bypass: when BUTTERBASE_E2E=1, allow tests to set the platform
    // user via x-test-user-id header. Minimal, header-scoped, and only honored
    // under the explicit env flag so it cannot leak into production.
    if (process.env.BUTTERBASE_E2E === '1') {
      const testUid = request.headers['x-test-user-id'];
      if (typeof testUid === 'string' && testUid.length > 0) {
        request.auth = {
          userId: testUid,
          authMethod: 'jwt',
          scopes: ['*'],
        };
        return;
      }
    }

    // Extract Authorization header
    const authHeader = request.headers.authorization;
    const token = authHeader?.startsWith('Bearer ')
      ? authHeader.substring(7)
      : null;

    // Service-key (bb_sk_*) — validated even when auth is disabled, so MCP/CLI
    // calls land on the real owner instead of the local devOwnerId default.
    // Without this branch, the dev escape hatch below would attribute every
    // service-key-bearing request to devOwnerId, and downstream owner checks
    // (e.g. resolveKvAuth's api_keys lookup) would mismatch.
    if (token && token.startsWith('bb_sk_')) {
      const authContext = await ApiKeyService.validateApiKey(
        fastify.controlDb,
        token
      );

      if (!authContext) {
        return reply.code(401).send(createAgentError({
          code: 'AUTH_INVALID_API_KEY',
          message: 'Invalid or revoked API key',
          remediation: 'Check that your API key is correct and has not been revoked. Generate a new key if needed.',
          documentation_url: getDocUrl('AUTH_INVALID_API_KEY'),
        }));
      }

      request.auth = authContext;
      return;
    }

    // Development escape hatch (anonymous or non-service-key requests only)
    if (!config.auth.enabled) {
      request.auth = {
        userId: config.devOwnerId,
        authMethod: 'api_key',
        scopes: ['*'],
      };
      return;
    }

    if (!token) {
      // Allow anonymous access - set anonymous auth context
      request.auth = {
        userId: null,
        authMethod: 'anonymous',
        scopes: [],
      };
      return;
    }

    {
      // Try to decode JWT to check if it's an end-user JWT
      try {
        const decoded = JSON.parse(
          Buffer.from(token.split('.')[1], 'base64').toString()
        );

        // Check if it's an end-user JWT (issuer starts with butterbase:app:)
        if (decoded.iss && decoded.iss.startsWith('butterbase:app:')) {
          // End-user JWT - defer verification to route handler
          request.auth = {
            userId: '', // Will be set by route handler
            authMethod: 'end_user_jwt',
            scopes: [],
            rawToken: token,
          } as any;
          return;
        }
      } catch {
        // Not a valid JWT, continue to platform JWT verification
      }

      // Platform JWT authentication (Cognito or local).
      // Verify token first (any throw here is a client-side auth failure → 401).
      // Subsequent DB / Stripe work is server-side; surface those at error level.
      let claims;
      try {
        claims = await authProvider.verifyJwt(token);
      } catch (error) {
        fastify.log.warn({ err: error }, 'JWT validation failed');
        return reply.code(401).send(createAgentError({
          code: 'AUTH_INVALID_TOKEN',
          message: 'Invalid JWT token',
          remediation: 'Verify your JWT token is valid and not expired. If using Cognito, ensure the token was issued for the correct user pool.',
          documentation_url: getDocUrl('AUTH_INVALID_TOKEN'),
        }));
      }

      try {
        // Upsert user into platform_users. We return plan_id from the INSERT
        // itself (DB default 'playground') so the signup-grant path below does
        // not race with provisionStripeCustomer to read it back.
        const result = await fastify.controlDb.query(
          `INSERT INTO platform_users (cognito_sub, email, email_verified)
           VALUES ($1, $2, $3)
           ON CONFLICT (cognito_sub)
           DO UPDATE SET email = $2, email_verified = $3, updated_at = now()
           RETURNING id, stripe_customer_id, plan_id`,
          [claims.sub, claims.email, claims.email_verified]
        );

        const userId = result.rows[0].id;
        const planId = result.rows[0].plan_id;

        // Auto-provision Stripe customer + Playground subscription for new users
        if (!result.rows[0].stripe_customer_id) {
          provisionStripeCustomer(fastify.controlDb, userId, claims.email).catch((err) => {
            fastify.log.error({ err }, `Failed to provision Stripe customer for user ${userId}`);
          });

          // Grant signup credits on first JIT auth. Idempotent — the partial unique
          // index on credit_grants (user_id) WHERE reason='signup' guarantees at-most-once.
          // Fire-and-forget: errors logged but never block auth.
          (async () => {
            try {
              const { grantSignupCredits } = await import('../services/credit-grants-service.js');
              await grantSignupCredits(fastify.controlDb, { userId, planId });
            } catch (err) {
              fastify.log.error(
                { err, userId, planId },
                'signup-grant: failed to grant signup credits'
              );
            }
          })();
        }

        request.auth = {
          userId,
          authMethod: 'jwt',
          scopes: ['*'],
          email: claims.email,
        };
      } catch (error) {
        fastify.log.error({ err: error }, 'JWT validation failed');
        return reply.code(401).send(createAgentError({
          code: 'AUTH_INVALID_TOKEN',
          message: 'Invalid JWT token',
          remediation: 'Verify your JWT token is valid and not expired. If using Cognito, ensure the token was issued for the correct user pool.',
          documentation_url: getDocUrl('AUTH_INVALID_TOKEN'),
        }));
      }
    }
  });

  // Helper decorator for scope checking
  fastify.decorate('requireScope', (scope: string) => {
    return async (request: FastifyRequest, reply: any) => {
      const hasScope = request.auth.scopes.includes('*') ||
                      request.auth.scopes.includes(scope);

      if (!hasScope) {
        return reply.code(403).send(createAgentError({
          code: 'AUTH_INSUFFICIENT_PERMISSIONS',
          message: `Missing required scope: ${scope}`,
          remediation: 'Your API key does not have the required scope for this operation. Generate a new key with the appropriate scopes.',
          documentation_url: getDocUrl('AUTH_INSUFFICIENT_PERMISSIONS'),
        }));
      }
    };
  });
};

export default fp(authPlugin, {
  name: 'auth',
});
