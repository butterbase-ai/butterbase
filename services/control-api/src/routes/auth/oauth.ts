import type { FastifyInstance } from 'fastify';
import { apiError } from '../../utils/api-error.js';
import querystring from 'node:querystring';
import { getOrCreateSigningKey } from '../../services/auth/signing-key-service.js';
import { signAccessToken, createRefreshToken } from '../../services/auth/token-service.js';
import { updateLastSignIn } from '../../services/auth/user-service.js';
import { createOAuthState, consumeOAuthState } from '../../services/auth/oauth-state-service.js';
import {
  resolveOAuthConfig,
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  extractUserInfo,
  generatePKCE,
} from '../../services/auth/oauth-flow-service.js';
import { config } from '../../config.js';
import { resolveAppHomeRegion } from '../../services/region-resolver.js';
import { getRuntimeDbPool } from '../../services/runtime-db.js';
import { logAuditEvent } from '../../services/auth/audit-service.js';
import { fireAuthHook } from '../../services/auth/auth-hook-service.js';

export async function oauthRoutes(app: FastifyInstance) {
  // Register content type parser for application/x-www-form-urlencoded
  // Needed for Apple's form_post response mode (POST callback)
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, body, done) => {
      done(null, querystring.parse(body as string));
    }
  );
  // INITIATE OAUTH FLOW — GET /auth/:app_id/oauth/:provider
  app.get('/auth/:app_id/oauth/:provider', {
    config: { public: true },
  }, async (request, reply) => {
    const { app_id, provider } = request.params as { app_id: string; provider: string };
    const { redirect_uri, redirect_to } = request.query as { redirect_uri?: string; redirect_to?: string };

    try {
      const region = await resolveAppHomeRegion(app.controlDb, app_id);
      const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
      const resolved = await resolveOAuthConfig(app.controlDb, app_id, provider);
      if (!resolved) {
        return reply.code(404).send({ error: 'OAuth provider not configured or disabled' });
      }

      if (!resolved.authorizationUrl) {
        return reply.code(500).send({ error: 'OAuth provider missing authorization URL' });
      }

      // Validate redirect_uri against whitelist if provided
      if (redirect_uri) {
        const configResult = await runtimeDb.query(
          `SELECT redirect_uris FROM app_oauth_configs WHERE app_id = $1 AND provider = $2`,
          [app_id, provider]
        );
        const redirectUris: string[] = configResult.rows[0]?.redirect_uris || [];
        if (!redirectUris.includes(redirect_uri)) {
          return reply.code(400).send({
            error: 'Invalid redirect_uri. Must be registered in OAuth configuration.'
          });
        }
      }

      // Validate redirect_to against allowed_origins
      if (redirect_to) {
        try {
          const redirectToUrl = new URL(redirect_to);
          const redirectOrigin = redirectToUrl.origin;

          const originsResult = await runtimeDb.query(
            `SELECT allowed_origins FROM apps WHERE id = $1`,
            [app_id]
          );
          const allowedOrigins: string[] = originsResult.rows[0]?.allowed_origins || [];

          // Also allow the platform dashboard URL
          const allAllowed = [...allowedOrigins, config.dashboardUrl];

          if (!allAllowed.includes(redirectOrigin)) {
            return reply.code(400).send({
              error: 'Invalid redirect_to. Its origin must be registered in allowed_origins.',
            });
          }
        } catch {
          return reply.code(400).send({ error: 'Invalid redirect_to URL.' });
        }
      }

      // Generate PKCE if provider requires it
      let codeVerifier: string | undefined;
      let codeChallenge: string | undefined;
      if (resolved.providerDef?.pkce) {
        const pkce = generatePKCE();
        codeVerifier = pkce.codeVerifier;
        codeChallenge = pkce.codeChallenge;
      }

      // Generate state token and store in database (with PKCE verifier if applicable)
      const state = await createOAuthState(app.controlDb, app_id, provider, redirect_to, codeVerifier);

      // Build authorization URL
      const authUrl = buildAuthorizationUrl(resolved, state, codeChallenge);

      return reply.redirect(authUrl);
    } catch (error) {
      app.log.error({ error }, 'OAuth initiation failed');
      return reply.code(500).send(apiError(error, 'Failed to initiate OAuth flow'));
    }
  });

  // OAUTH CALLBACK (GET) — GET /auth/:app_id/oauth/:provider/callback
  app.get('/auth/:app_id/oauth/:provider/callback', {
    config: { public: true },
  }, async (request, reply) => {
    const { app_id, provider } = request.params as { app_id: string; provider: string };
    const { code, state, error: oauthError } = request.query as {
      code?: string;
      state?: string;
      error?: string;
    };

    return handleOAuthCallback(app, request, reply, app_id, provider, code, state, oauthError);
  });

  // OAUTH CALLBACK (POST) — POST /auth/:app_id/oauth/:provider/callback
  // Apple Sign In uses form_post response mode, sending data as POST form body
  app.post('/auth/:app_id/oauth/:provider/callback', {
    config: { public: true },
  }, async (request, reply) => {
    const { app_id, provider } = request.params as { app_id: string; provider: string };

    // Parse form body — Apple sends code, id_token, state, and optionally user as form fields
    const body = request.body as Record<string, string> | undefined;
    const code = body?.code;
    const state = body?.state;
    const oauthError = body?.error;

    return handleOAuthCallback(app as any, request, reply, app_id, provider, code, state, oauthError);
  });
}

/**
 * Shared callback handler for both GET and POST OAuth callbacks.
 */
async function handleOAuthCallback(
  app: FastifyInstance,
  request: any,
  reply: any,
  appId: string,
  provider: string,
  code?: string,
  state?: string,
  oauthError?: string
) {
  const region = await resolveAppHomeRegion(app.controlDb, appId);
  const runtimeDb = getRuntimeDbPool(config.runtimeDb, region);
  const logFailure = (reason: string, userId?: string) => {
    logAuditEvent(runtimeDb, {
      appId,
      userId,
      eventType: 'oauth_login_failed',
      eventData: { provider, reason },
      ipAddress: request?.ip,
      userAgent: request?.headers?.['user-agent'],
      success: false,
      errorMessage: reason,
    }).catch(() => {});
  };

  try {

    if (oauthError) {
      logFailure(`provider_error:${oauthError}`);
      return reply.code(400).send({ error: `OAuth error: ${oauthError}` });
    }

    if (!code || !state) {
      logFailure('missing_code_or_state');
      return reply.code(400).send({ error: 'Missing code or state parameter' });
    }

    // Verify and consume state
    const stateData = await consumeOAuthState(app.controlDb, appId, state);
    if (!stateData) {
      logFailure('invalid_or_expired_state');
      return reply.code(400).send({ error: 'Invalid or expired state' });
    }

    if (stateData.appId !== appId || stateData.provider !== provider) {
      logFailure('state_mismatch');
      return reply.code(400).send({ error: 'State mismatch' });
    }

    // Resolve OAuth config
    const resolved = await resolveOAuthConfig(app.controlDb, appId, provider);
    if (!resolved) {
      return reply.code(404).send({ error: 'OAuth provider not configured' });
    }

    // Exchange code for tokens (with PKCE verifier if stored)
    const tokens = await exchangeCodeForTokens(resolved, code, stateData.codeVerifier);

    if (!tokens.accessToken && !tokens.idToken) {
      return reply.code(500).send({ error: 'No tokens received from provider' });
    }

    // Extract user info
    const userInfo = await extractUserInfo(resolved, tokens);

    if (!userInfo.providerUid || !userInfo.email) {
      return reply.code(500).send({ error: 'Missing required user information from provider' });
    }

    // Upsert user — three-branch CTE so we can link an existing email/password
    // (or other-provider) row in place rather than tripping the (app_id, email)
    // unique constraint. Order:
    //   1) match by (app_id, provider, provider_uid) — repeat OAuth login
    //   2) match by (app_id, email) — claim an existing local row, attach the
    //      provider/provider_uid; password_hash is preserved so the user keeps
    //      both sign-in paths
    //   3) otherwise INSERT a new row
    let userResult;
    try {
      userResult = await runtimeDb.query(
        `WITH input AS (
           SELECT $1::text AS app_id, $2::text AS email, $3::text AS provider,
                  $4::text AS provider_uid, $5::text AS display_name, $6::text AS avatar_url
         ),
         linked_by_uid AS (
           UPDATE app_users u
              SET email = i.email,
                  display_name = COALESCE(i.display_name, u.display_name),
                  avatar_url   = COALESCE(i.avatar_url,   u.avatar_url),
                  email_verified = true,
                  updated_at = now()
             FROM input i
            WHERE u.app_id = i.app_id
              AND u.provider = i.provider
              AND u.provider_uid = i.provider_uid
            RETURNING u.id, u.email, u.email_verified, u.display_name, u.avatar_url, false AS is_new_user
         ),
         linked_by_email AS (
           UPDATE app_users u
              SET provider = i.provider,
                  provider_uid = i.provider_uid,
                  display_name = COALESCE(i.display_name, u.display_name),
                  avatar_url   = COALESCE(i.avatar_url,   u.avatar_url),
                  email_verified = true,
                  updated_at = now()
             FROM input i
            WHERE u.app_id = i.app_id
              AND u.email = i.email
              AND NOT EXISTS (SELECT 1 FROM linked_by_uid)
            RETURNING u.id, u.email, u.email_verified, u.display_name, u.avatar_url, false AS is_new_user
         ),
         inserted AS (
           INSERT INTO app_users (app_id, email, provider, provider_uid, display_name, avatar_url, email_verified)
           SELECT i.app_id, i.email, i.provider, i.provider_uid, i.display_name, i.avatar_url, true
             FROM input i
            WHERE NOT EXISTS (SELECT 1 FROM linked_by_uid)
              AND NOT EXISTS (SELECT 1 FROM linked_by_email)
           RETURNING id, email, email_verified, display_name, avatar_url, true AS is_new_user
         )
         SELECT * FROM linked_by_uid
         UNION ALL
         SELECT * FROM linked_by_email
         UNION ALL
         SELECT * FROM inserted`,
        [appId, userInfo.email, provider, userInfo.providerUid, userInfo.displayName, userInfo.avatarUrl]
      );
    } catch (err: any) {
      // 23505 here means the OAuth identity (provider, provider_uid) is already
      // linked to a *different* email row in this app — we can't claim the local
      // email row without violating idx_app_users_provider_uid.
      if (err && err.code === '23505') {
        return reply.code(409).send({
          error: 'oauth_identity_already_linked',
          message:
            'This OAuth account is already linked to a different email in this app. ' +
            'Sign in with the original email or unlink the existing account first.',
        });
      }
      throw err;
    }

    if (!userResult.rows.length) {
      return reply.code(500).send({ error: 'Failed to upsert user' });
    }
    const user = userResult.rows[0];

    if (user.is_new_user) {
      app.platformEventBus.emit('auth.signup.completed', {
        appId,
        userId: user.id,
        email: user.email,
        displayName: user.display_name,
        provider, // actual provider string ('google', 'github', etc.) — variable already in scope
        runtimeDb,
      });
    }

    // Get signing key
    const signingKey = await getOrCreateSigningKey(app.controlDb, appId);

    // Get JWT config for app
    const appConfigResult = await runtimeDb.query(
      `SELECT jwt_config FROM apps WHERE id = $1`,
      [appId]
    );
    const jwtConfig = appConfigResult.rows[0]?.jwt_config || {
      accessTokenTtl: '1h',
      refreshTokenTtlDays: 7
    };

    // Sign access token
    const appAccessToken = await signAccessToken(
      signingKey.privateKey,
      signingKey.kid,
      {
        sub: user.id,
        email: user.email,
        app_id: appId,
        email_verified: user.email_verified,
      },
      jwtConfig.accessTokenTtl
    );

    // Create refresh token
    const refreshToken = await createRefreshToken(
      app.controlDb,
      appId,
      user.id,
      jwtConfig.refreshTokenTtlDays
    );

    // Update last sign-in
    await updateLastSignIn(app.controlDb, appId, user.id);

    logAuditEvent(runtimeDb, {
      appId,
      userId: user.id,
      eventType: 'oauth_login',
      eventData: { provider, email: user.email },
      ipAddress: request?.ip,
      userAgent: request?.headers?.['user-agent'],
      success: true,
    }).catch(() => {});

    // Fire post_auth hook (fire-and-forget)
    fireAuthHook(app.controlDb, appId, {
      event: 'oauth_login',
      user: {
        id: user.id,
        email: user.email,
        provider,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
      },
      isNewUser: user.is_new_user,
      provider,
    }, app.log);

    // Convert TTL string to seconds for expires_in
    const ttlMatch = jwtConfig.accessTokenTtl.match(/^(\d+)([smhd])$/);
    let expiresInSeconds = 900;
    if (ttlMatch) {
      const value = parseInt(ttlMatch[1]);
      const unit = ttlMatch[2] as 's' | 'm' | 'h' | 'd';
      const multipliers: Record<'s' | 'm' | 'h' | 'd', number> = { s: 1, m: 60, h: 3600, d: 86400 };
      expiresInSeconds = value * multipliers[unit];
    }

    // If redirect_to is provided, redirect to frontend with tokens
    if (stateData.redirectTo) {
      const redirectUrl = new URL(stateData.redirectTo);
      redirectUrl.searchParams.set('access_token', appAccessToken);
      redirectUrl.searchParams.set('refresh_token', refreshToken);
      redirectUrl.searchParams.set('expires_in', expiresInSeconds.toString());
      redirectUrl.searchParams.set('token_type', 'Bearer');
      return reply.redirect(redirectUrl.toString());
    }

    // Otherwise, return tokens as JSON
    return reply.send({
      access_token: appAccessToken,
      refresh_token: refreshToken,
      expires_in: expiresInSeconds,
      token_type: 'Bearer',
      user: {
        id: user.id,
        email: user.email,
        email_verified: user.email_verified,
        display_name: user.display_name,
        avatar_url: user.avatar_url,
      },
    });
  } catch (error) {
    logFailure((error as Error).message ?? 'unknown');
    app.log.error({ error }, 'OAuth callback failed');
    return reply.code(500).send(apiError(error, 'OAuth authentication failed'));
  }
}
