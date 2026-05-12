import React, { createContext, useContext, useEffect, useState } from 'react';
import { AuthChangeEvent, Session, User } from '@supabase/supabase-js';
import { supabase } from '../services/supabase';

interface AuthContextValue {
  user: User | null;
  session: Session | null;
  loading: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue>({
  user: null,
  session: null,
  loading: true,
  signIn: async () => {},
  signUp: async () => {},
  signOut: async () => {},
});

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // Restore persisted session from AsyncStorage. Always resolve loading so
    // the rest of the app is never blocked by an auth failure.
    supabase.auth.getSession()
      .then(({ data: { session: currentSession } }) => {
        setSession(currentSession);
        setUser(currentSession?.user ?? null);
      })
      .catch((err) => {
        console.warn('[Auth] Failed to restore session:', err);
      })
      .finally(() => {
        setLoading(false);
      });

    // Subscribe to auth state changes (login, logout, token refresh)
    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((event: AuthChangeEvent, updatedSession) => {
      setSession(updatedSession);
      setUser(updatedSession?.user ?? null);

      if (event === 'TOKEN_REFRESHED') {
        console.log('[Auth] Token refreshed successfully.');
      } else if (event === 'SIGNED_OUT') {
        // Covers both explicit sign-out and expired refresh tokens.
        // Public content remains fully functional via the anon key.
        console.log('[Auth] Session ended — public browsing continues.');
      }
    });

    return () => subscription.unsubscribe();
  }, []);

  const signIn = async (email: string, password: string): Promise<void> => {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) throw error;
  };

  const signUp = async (email: string, password: string): Promise<void> => {
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) throw error;
  };

  const signOut = async (): Promise<void> => {
    const { error } = await supabase.auth.signOut();
    if (error) throw error;
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
