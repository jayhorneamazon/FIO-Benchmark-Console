/**
 * React context provider for authentication.
 * Wraps the app and provides auth state + actions to all components.
 */

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { Auth, AuthUser } from '../lib/auth';
import { getAuthConfig } from '../lib/auth-config';
import { setAuthProvider } from '../lib/api';

interface AuthContextValue {
  user: AuthUser | null;
  isLoading: boolean;
  signIn: () => Promise<void>;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  isLoading: true,
  signIn: async () => {},
  signOut: () => {},
});

export const useAuth = () => useContext(AuthContext);

let authSingleton: Auth | null = null;

function getAuth(): Auth {
  if (!authSingleton) {
    const config = getAuthConfig();
    authSingleton = new Auth(config);
    setAuthProvider(authSingleton);
  }
  return authSingleton;
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const auth = getAuth();

    // Check if we're handling an OAuth callback
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');

    if (code && window.location.pathname === '/auth/callback') {
      auth.handleCallback(code)
        .then(u => {
          setUser(u);
          // Clean the URL — remove the code parameter
          window.history.replaceState({}, '', '/');
        })
        .catch(err => {
          console.error('Auth callback failed:', err);
        })
        .finally(() => setIsLoading(false));
    } else {
      // Check for existing session
      const existingUser = auth.getUser();
      if (existingUser) {
        setUser(existingUser);
      }
      setIsLoading(false);
    }
  }, []);

  const signIn = useCallback(async () => {
    const auth = getAuth();
    await auth.signIn();
  }, []);

  const signOut = useCallback(() => {
    const auth = getAuth();
    auth.signOut();
    setUser(null);
  }, []);

  return (
    <AuthContext.Provider value={{ user, isLoading, signIn, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};

/**
 * Wrapper component that requires authentication.
 * Shows a sign-in prompt if the user is not authenticated.
 */
export const RequireAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, isLoading, signIn } = useAuth();

  if (isLoading) {
    return (
      <div className="auth-loading" role="status" aria-label="Checking authentication">
        <p>Checking authentication...</p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="auth-required">
        <h2>FIO Benchmark Console</h2>
        <p>Sign in to access the benchmark console.</p>
        <button onClick={signIn} className="sign-in-button">
          Sign In
        </button>
      </div>
    );
  }

  return <>{children}</>;
};
