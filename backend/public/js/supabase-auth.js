/**
 * Shared Supabase client bootstrap + token-refresh sync.
 * Loaded by dashboard.html and access-pending.html, before api-client.js.
 *
 * Previously the Supabase client only ever existed inside login.html's own inline <script>,
 * torn down the moment the browser navigated to /dashboard.html - so autoRefreshToken had
 * nothing left to refresh for the entire time a user actually used the app. api-client.js read
 * a single localStorage['auth_token'] snapshot taken at login and never updated it, so once that
 * one token's exp passed, every request 401'd and the user was bounced to /login.html - not a
 * Supabase tier limitation, just a token that nothing was ever refreshing.
 *
 * This module keeps one Supabase client instance alive for the page's whole lifetime and syncs
 * localStorage['auth_token'] every time the SDK rotates the token in the background.
 */

(function () {
  let clientPromise = null;
  let refreshPromise = null;

  async function initClient() {
    const response = await fetch('/api/v1/public-config');
    const config = await response.json();
    if (!config?.data?.supabaseUrl || !config?.data?.supabaseAnonKey) {
      throw new Error('Supabase configuration is missing');
    }
    if (!window.supabase) {
      throw new Error('Supabase SDK failed to load');
    }

    const client = window.supabase.createClient(
      config.data.supabaseUrl,
      config.data.supabaseAnonKey,
      {
        auth: {
          autoRefreshToken: true,
          persistSession: true,
          detectSessionInUrl: true,
        },
      }
    );

    client.auth.onAuthStateChange((event, session) => {
      try {
        if (session?.access_token) {
          localStorage.setItem('auth_token', session.access_token);
        } else if (event === 'SIGNED_OUT') {
          localStorage.removeItem('auth_token');
        }
      } catch (_) {
        // ignore localStorage errors (private mode, etc.)
      }
    });

    window.supabaseClient = client;
    return client;
  }

  function getClient() {
    if (!clientPromise) {
      clientPromise = initClient();
    }
    return clientPromise;
  }

  /**
   * Returns a valid (refreshing if needed) access token, or null if there's no session to
   * refresh (refresh token itself expired/revoked - the correct case to actually log out).
   * Concurrent callers share one in-flight refresh instead of each triggering their own.
   */
  function ensureFreshSession() {
    if (!refreshPromise) {
      refreshPromise = (async () => {
        try {
          const client = await getClient();
          const { data, error } = await client.auth.getSession();
          if (error || !data?.session?.access_token) {
            return null;
          }
          try {
            localStorage.setItem('auth_token', data.session.access_token);
          } catch (_) {
            // ignore
          }
          return data.session.access_token;
        } catch (err) {
          console.error('Session refresh failed', err);
          return null;
        } finally {
          refreshPromise = null;
        }
      })();
    }
    return refreshPromise;
  }

  window.supabaseAuth = { getClient, ensureFreshSession };

  // Kick off initialization immediately so window.supabaseClient is ready as soon as possible.
  getClient().catch((err) => console.error('Supabase client init failed', err));
})();
