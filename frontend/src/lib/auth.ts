/**
 * Cognito authentication module.
 *
 * Uses the authorization code flow with PKCE (no client secret).
 * Handles token storage, refresh, and redirect-based sign-in via
 * the Cognito hosted UI.
 *
 * No dependency on aws-amplify — this is a lightweight implementation
 * using standard OAuth2/OIDC against the Cognito endpoints directly.
 */

export interface AuthConfig {
  userPoolId: string;
  clientId: string;
  cognitoDomain: string; // e.g., "fio-bench-xxxx.auth.us-east-1.amazoncognito.com"
  redirectUri: string;   // e.g., "https://d1234.cloudfront.net/auth/callback"
  logoutUri: string;     // e.g., "https://d1234.cloudfront.net/"
}

export interface AuthUser {
  sub: string;
  email: string;
  givenName?: string;
  familyName?: string;
}

interface TokenSet {
  idToken: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

const STORAGE_KEY = 'fio_bench_auth';
const PKCE_VERIFIER_KEY = 'fio_bench_pkce_verifier';

// --- PKCE helpers ---

function generateRandomString(length: number): string {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('').slice(0, length);
}

async function sha256(plain: string): Promise<ArrayBuffer> {
  const encoder = new TextEncoder();
  return crypto.subtle.digest('SHA-256', encoder.encode(plain));
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function generatePkceChallenge(): Promise<{ verifier: string; challenge: string }> {
  const verifier = generateRandomString(64);
  const hashed = await sha256(verifier);
  const challenge = base64UrlEncode(hashed);
  return { verifier, challenge };
}

// --- Token storage ---

function getStoredTokens(): TokenSet | null {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function storeTokens(tokens: TokenSet): void {
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(tokens));
}

function clearTokens(): void {
  sessionStorage.removeItem(STORAGE_KEY);
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);
}

// --- JWT decode (no verification — that's the API Gateway's job) ---

function decodeJwtPayload(token: string): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Invalid JWT');
  const payload = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  return JSON.parse(atob(payload));
}

// --- Auth class ---

export class Auth {
  private config: AuthConfig;
  private tokens: TokenSet | null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: AuthConfig) {
    this.config = config;
    this.tokens = getStoredTokens();
    this.scheduleRefresh();
  }

  /** Returns the current user if authenticated, null otherwise */
  getUser(): AuthUser | null {
    if (!this.tokens || Date.now() >= this.tokens.expiresAt) return null;
    try {
      const payload = decodeJwtPayload(this.tokens.idToken);
      return {
        sub: payload.sub as string,
        email: payload.email as string,
        givenName: payload.given_name as string | undefined,
        familyName: payload.family_name as string | undefined,
      };
    } catch {
      return null;
    }
  }

  /** Returns the current access token for API calls, or null if not authenticated */
  getAccessToken(): string | null {
    if (!this.tokens) return null;
    if (Date.now() >= this.tokens.expiresAt) {
      // Token expired — try refresh in background, return null for now
      this.refreshTokens();
      return null;
    }
    return this.tokens.accessToken;
  }

  /** Returns true if the user is authenticated with a valid (non-expired) token */
  isAuthenticated(): boolean {
    return this.getUser() !== null;
  }

  /** Redirects to the Cognito hosted UI for sign-in */
  async signIn(): Promise<void> {
    const { verifier, challenge } = await generatePkceChallenge();
    sessionStorage.setItem(PKCE_VERIFIER_KEY, verifier);

    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: 'openid email profile',
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    window.location.href = `https://${this.config.cognitoDomain}/oauth2/authorize?${params}`;
  }

  /** Handles the OAuth callback — exchanges the authorization code for tokens */
  async handleCallback(code: string): Promise<AuthUser> {
    const verifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
    if (!verifier) throw new Error('PKCE verifier not found — sign-in flow was not initiated from this session');

    const response = await fetch(`https://${this.config.cognitoDomain}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: this.config.clientId,
        code,
        redirect_uri: this.config.redirectUri,
        code_verifier: verifier,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      clearTokens();
      throw new Error(`Token exchange failed: ${err}`);
    }

    const data = await response.json();
    this.setTokensFromResponse(data);
    sessionStorage.removeItem(PKCE_VERIFIER_KEY);

    const user = this.getUser();
    if (!user) throw new Error('Failed to decode user from token');
    return user;
  }

  /** Signs out — clears local tokens and redirects to Cognito logout */
  signOut(): void {
    clearTokens();
    this.tokens = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);

    const params = new URLSearchParams({
      client_id: this.config.clientId,
      logout_uri: this.config.logoutUri,
    });

    window.location.href = `https://${this.config.cognitoDomain}/logout?${params}`;
  }

  /** Attempts to refresh the access token using the refresh token */
  async refreshTokens(): Promise<boolean> {
    if (!this.tokens?.refreshToken) return false;

    try {
      const response = await fetch(`https://${this.config.cognitoDomain}/oauth2/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          client_id: this.config.clientId,
          refresh_token: this.tokens.refreshToken,
        }),
      });

      if (!response.ok) {
        clearTokens();
        this.tokens = null;
        return false;
      }

      const data = await response.json();
      // Refresh response doesn't include a new refresh token — keep the existing one
      this.setTokensFromResponse({
        ...data,
        refresh_token: data.refresh_token || this.tokens.refreshToken,
      });
      return true;
    } catch {
      return false;
    }
  }

  private setTokensFromResponse(data: {
    id_token: string;
    access_token: string;
    refresh_token: string;
    expires_in: number;
  }): void {
    this.tokens = {
      idToken: data.id_token,
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + data.expires_in * 1000,
    };
    storeTokens(this.tokens);
    this.scheduleRefresh();
  }

  private scheduleRefresh(): void {
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (!this.tokens) return;

    // Refresh 5 minutes before expiry
    const msUntilRefresh = this.tokens.expiresAt - Date.now() - 5 * 60 * 1000;
    if (msUntilRefresh <= 0) return;

    this.refreshTimer = setTimeout(() => this.refreshTokens(), msUntilRefresh);
  }
}
