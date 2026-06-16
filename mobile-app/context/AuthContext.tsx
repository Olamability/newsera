import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { AuthChangeEvent, Session, User } from '@supabase/supabase-js';
import { supabaseAuth } from '../services/supabase';

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
  const authEventReceivedRef = useRef(false);

  const applySession = (nextSession: Session | null) => {
    setSession(nextSession);
    setUser(nextSession?.user ?? null);
  };

  useEffect(() => {
    let mounted = true;

    // Subscribe to auth state changes globally (login, logout, token refresh)
    const {
      data: { subscription },
    } = supabaseAuth.auth.onAuthStateChange((event: AuthChangeEvent, updatedSession) => {
      authEventReceivedRef.current = true;
      if (!mounted) return;
      applySession(updatedSession);
      setLoading(false);

      if (event === 'TOKEN_REFRESHED') {
        console.log('[Auth] Token refreshed successfully.');
      } else if (event === 'SIGNED_OUT') {
        // Covers both explicit sign-out and expired refresh tokens.
        // Public content remains fully functional via the anon key.
        console.log('[Auth] Session ended — public browsing continues.');
      }
    });

    // Restore persisted session from AsyncStorage. If an auth event already
    // updated state, skip applying this result to avoid stale-session races.
    supabaseAuth.auth.getSession()
      .then(({ data: { session: currentSession } }) => {
        if (!mounted || authEventReceivedRef.current) return;
        applySession(currentSession);
      })
      .catch((err) => {
        console.warn('[Auth] Failed to restore session:', err);
      })
      .finally(() => {
        if (mounted) {
          setLoading(false);
        }
      });

    return () => {
      mounted = false;
      subscription.unsubscribe();
    };
  }, []);

  const signIn = async (email: string, password: string): Promise<void> => {
    const { data, error } = await supabaseAuth.auth.signInWithPassword({ email, password });
    if (error) throw error;
    applySession(data.session ?? null);
  };

  const signUp = async (email: string, password: string): Promise<void> => {
    const { data, error } = await supabaseAuth.auth.signUp({ 
      email, 
      password,
      options: {
        emailRedirectTo: undefined, // Disable email confirmation redirect for mobile
      }
    });
    if (error) {
      if (__DEV__) {
        console.error('[Auth] Sign up error:', error);
      }
      throw error;
    }
    // Only apply session if email confirmation is NOT required
    // If email confirmation is required, data.session will be null
    if (data.session) {
      applySession(data.session);
    } else {
      applySession(null);
    }
  };

  const signOut = async (): Promise<void> => {
    const { error } = await supabaseAuth.auth.signOut();
    if (error) throw error;
    applySession(null);
  };

  return (
    <AuthContext.Provider value={{ user, session, loading, signIn, signUp, signOut }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => useContext(AuthContext);
