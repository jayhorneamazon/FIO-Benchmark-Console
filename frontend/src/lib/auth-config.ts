/**
 * Auth configuration loaded from environment variables.
 * These are injected at build time via Vite's env system.
 *
 * Create a .env.local file in frontend/ with:
 *   VITE_USER_POOL_ID=us-east-1_xxxxxxx
 *   VITE_CLIENT_ID=xxxxxxxxxxxxxxxxxxxxxxxxxx
 *   VITE_COGNITO_DOMAIN=fio-bench-xxxx.auth.us-east-1.amazoncognito.com
 *   VITE_REDIRECT_URI=https://d1234.cloudfront.net/auth/callback
 *   VITE_LOGOUT_URI=https://d1234.cloudfront.net/
 *
 * These values come from the CDK stack outputs after deployment.
 */

import { AuthConfig } from './auth';

export function getAuthConfig(): AuthConfig {
  const userPoolId = import.meta.env.VITE_USER_POOL_ID;
  const clientId = import.meta.env.VITE_CLIENT_ID;
  const cognitoDomain = import.meta.env.VITE_COGNITO_DOMAIN;

  if (!userPoolId || !clientId || !cognitoDomain) {
    throw new Error(
      'Missing auth configuration. Set VITE_USER_POOL_ID, VITE_CLIENT_ID, and VITE_COGNITO_DOMAIN in .env.local'
    );
  }

  // Default redirect URIs based on current origin
  const origin = window.location.origin;
  const redirectUri = import.meta.env.VITE_REDIRECT_URI || `${origin}/auth/callback`;
  const logoutUri = import.meta.env.VITE_LOGOUT_URI || `${origin}/`;

  return {
    userPoolId,
    clientId,
    cognitoDomain,
    redirectUri,
    logoutUri,
  };
}
