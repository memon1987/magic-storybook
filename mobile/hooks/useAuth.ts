import { useState, useEffect, useCallback } from 'react';
import { User } from 'firebase/auth';
import { onAuthChange, signIn, signOut, register } from '../services/firebase';

interface AuthState {
  user: User | null;
  loading: boolean;
  error: string | null;
}

interface UseAuthReturn extends AuthState {
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
  signup: (email: string, password: string) => Promise<void>;
  clearError: () => void;
}

export function useAuth(): UseAuthReturn {
  const [state, setState] = useState<AuthState>({
    user: null,
    loading: true,
    error: null,
  });

  useEffect(() => {
    const unsubscribe = onAuthChange((user) => {
      setState((prev) => ({
        ...prev,
        user,
        loading: false,
      }));
    });

    return unsubscribe;
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      await signIn(email, password);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Login failed';
      setState((prev) => ({ ...prev, error: message, loading: false }));
      throw error;
    }
  }, []);

  const logout = useCallback(async () => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      await signOut();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Logout failed';
      setState((prev) => ({ ...prev, error: message, loading: false }));
      throw error;
    }
  }, []);

  const signup = useCallback(async (email: string, password: string) => {
    setState((prev) => ({ ...prev, loading: true, error: null }));
    try {
      await register(email, password);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Registration failed';
      setState((prev) => ({ ...prev, error: message, loading: false }));
      throw error;
    }
  }, []);

  const clearError = useCallback(() => {
    setState((prev) => ({ ...prev, error: null }));
  }, []);

  return {
    ...state,
    login,
    logout,
    signup,
    clearError,
  };
}

export default useAuth;
