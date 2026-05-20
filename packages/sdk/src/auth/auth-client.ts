import type { ButterbaseClient } from '../lib/butterbase-client.js';
import type {
  ButterbaseResponse,
  SignUpParams,
  SignInParams,
  AuthResponse,
  LoginResponse,
  SignupResponse,
  User,
  OAuthParams,
  OAuthCallbackResult,
} from '../types/index.js';

export class AuthClient {
  constructor(private client: ButterbaseClient) {
    // Register refresh function with session manager
    this.client.sessionManager.setRefreshFunction(async (refreshToken: string) => {
      return this.client.request<LoginResponse>(
        'POST',
        `/auth/${this.client.appId}/refresh`,
        { refresh_token: refreshToken }
      );
    });
  }

  /**
   * Sign up a new user with email and password
   * Note: API returns user and message, but no tokens (email verification required)
   */
  async signUp(params: SignUpParams): Promise<ButterbaseResponse<SignupResponse>> {
    try {
      const response = await this.client.request<SignupResponse>(
        'POST',
        `/auth/${this.client.appId}/signup`,
        params
      );

      // No token returned from signup - user must verify email first
      return { data: response, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Sign in an existing user with email and password
   */
  async signIn(params: SignInParams): Promise<ButterbaseResponse<LoginResponse>> {
    try {
      const response = await this.client.request<LoginResponse>(
        'POST',
        `/auth/${this.client.appId}/login`,
        params
      );

      // Persist full session and set access token
      const session = this.client.sessionManager.setSessionFromLoginResponse(
        response,
        'SIGNED_IN'
      );
      this.client.setAccessToken(session.accessToken);

      return { data: response, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Sign out the current user
   */
  async signOut(): Promise<ButterbaseResponse<void>> {
    try {
      await this.client.request<void>(
        'POST',
        `/auth/${this.client.appId}/logout`,
        {}
      );

      this.client.setAccessToken(undefined);
      this.client.sessionManager.clearSession();

      return { data: null, error: null };
    } catch (error) {
      // Still clear local state even if API call fails
      this.client.setAccessToken(undefined);
      this.client.sessionManager.clearSession();
      return { data: null, error: error as Error };
    }
  }

  /**
   * Get the current authenticated user
   */
  async getUser(): Promise<ButterbaseResponse<User>> {
    try {
      const user = await this.client.request<User>(
        'GET',
        `/auth/${this.client.appId}/me`
      );

      return { data: user, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Initiate OAuth sign-in flow
   * Returns the URL to redirect the user to
   */
  signInWithOAuth(params: OAuthParams): { url: string } {
    const apiUrl = this.client['apiUrl']; // Access private property
    const url = `${apiUrl}/auth/${this.client.appId}/oauth/${params.provider}?redirect_to=${encodeURIComponent(params.redirectTo)}`;
    return { url };
  }

  /**
   * Handle the OAuth callback after the provider redirects back.
   * Reads tokens from the URL query params, sets the session, fetches
   * the authenticated user, and cleans up the URL.
   *
   * Call this on your OAuth callback page:
   *   const { data, error } = await butterbase.auth.handleOAuthCallback();
   */
  async handleOAuthCallback(): Promise<ButterbaseResponse<OAuthCallbackResult>> {
    try {
      if (typeof globalThis.window === 'undefined' || !globalThis.window.location) {
        return { data: null, error: new Error('handleOAuthCallback is only available in browser environments') };
      }

      const params = new URLSearchParams(window.location.search);
      const accessToken = params.get('access_token');
      const refreshToken = params.get('refresh_token');
      const expiresIn = params.get('expires_in');

      if (!accessToken || !refreshToken) {
        return { data: null, error: new Error('No OAuth tokens found in URL. Ensure the OAuth redirect includes access_token and refresh_token parameters.') };
      }

      // Set the access token so we can make authenticated requests
      this.client.setAccessToken(accessToken);

      // Fetch the real user from the API
      const user = await this.client.request<User>(
        'GET',
        `/auth/${this.client.appId}/me`
      );

      // Build a full LoginResponse and persist the session
      const loginResponse: LoginResponse = {
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_in: expiresIn ? parseInt(expiresIn, 10) : 3600,
        token_type: 'Bearer',
        user,
      };

      const session = this.client.sessionManager.setSessionFromLoginResponse(
        loginResponse,
        'SIGNED_IN'
      );

      // Clean tokens from the URL to avoid leaking them in history/logs
      cleanUrlParams(['access_token', 'refresh_token', 'expires_in', 'token_type']);

      return {
        data: { user, session },
        error: null,
      };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Refresh the access token using a refresh token.
   * If no token is provided, uses the stored refresh token.
   */
  async refreshSession(refreshToken?: string): Promise<ButterbaseResponse<LoginResponse>> {
    try {
      const token = refreshToken ?? this.client.sessionManager.getSession()?.refreshToken;
      if (!token) {
        return { data: null, error: new Error('No refresh token available') };
      }

      const response = await this.client.request<LoginResponse>(
        'POST',
        `/auth/${this.client.appId}/refresh`,
        { refresh_token: token }
      );

      // Persist new session and update access token
      const session = this.client.sessionManager.setSessionFromLoginResponse(
        response,
        'TOKEN_REFRESHED'
      );
      this.client.setAccessToken(session.accessToken);

      return { data: response, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Request a password reset email
   */
  async forgotPassword(email: string): Promise<ButterbaseResponse<void>> {
    try {
      await this.client.request<void>(
        'POST',
        `/auth/${this.client.appId}/forgot-password`,
        { email }
      );

      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Reset password with token from email
   */
  async resetPassword(token: string, newPassword: string): Promise<ButterbaseResponse<void>> {
    try {
      await this.client.request<void>(
        'POST',
        `/auth/${this.client.appId}/reset-password`,
        { token, newPassword }
      );

      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Send a magic-link sign-in code to the given email.
   * If no user exists, one is auto-created (passwordless signup).
   */
  async sendMagicLink(email: string): Promise<ButterbaseResponse<{ message: string }>> {
    try {
      const response = await this.client.request<{ message: string }>(
        'POST',
        `/auth/${this.client.appId}/magic-link`,
        { email }
      );

      return { data: response, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Verify a magic-link code and sign in.
   * Returns tokens and sets the session, just like signIn().
   */
  async verifyMagicLink(email: string, code: string): Promise<ButterbaseResponse<LoginResponse>> {
    try {
      const response = await this.client.request<LoginResponse>(
        'POST',
        `/auth/${this.client.appId}/magic-link/verify`,
        { email, code }
      );

      // Persist session and set access token (same as signIn)
      const session = this.client.sessionManager.setSessionFromLoginResponse(
        response,
        'SIGNED_IN'
      );
      this.client.setAccessToken(session.accessToken);

      return { data: response, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }

  /**
   * Verify email with verification code
   */
  async verifyEmail(email: string, code: string): Promise<ButterbaseResponse<void>> {
    try {
      await this.client.request<void>(
        'POST',
        `/auth/${this.client.appId}/verify-email`,
        { email, code }
      );

      return { data: null, error: null };
    } catch (error) {
      return { data: null, error: error as Error };
    }
  }
}

/**
 * Remove OAuth-related params from the browser URL without triggering a navigation.
 */
function cleanUrlParams(keys: string[]): void {
  try {
    const url = new URL(window.location.href);
    for (const key of keys) {
      url.searchParams.delete(key);
    }
    window.history.replaceState(window.history.state, '', url.toString());
  } catch {
    // Non-critical — swallow if history API is unavailable
  }
}
