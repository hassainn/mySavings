/* Member access gate — Supabase email + password login + approved allow-list.
 *
 * The app is a static site, so this gates the UI experience. It becomes ACTIVE
 * only once SUPABASE_URL and SUPABASE_ANON_KEY are filled in below; until then
 * the site loads normally (so nothing breaks during setup).
 *
 * Why password (not magic link): magic links depend on email delivery (rate
 * limited on the free tier) and a matching Redirect URL, and the session felt
 * "temporary". Password sign-in needs no email round-trip and the Supabase
 * client keeps the session signed in (auto-refresh), so members stay logged in.
 *
 * First sign-in sets the member's password (the project has email auto-confirm
 * on, so no confirmation email is needed). Only emails on the approved list —
 * the bootstrap set below OR the Supabase `approved_members` table — can sign in
 * or register.
 *
 * Note: this hides the UI behind login. To make the DATA itself private, the
 * feeds must later move behind Supabase row-level security.
 */
(function () {
  "use strict";

  const SUPABASE_URL = "https://edmvmyogbfxrbxhkqoag.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_abFsuEay_0vkvZPbVJotGQ_BFWc4Ep4"; // publishable (browser-safe)
  // Always-allowed members (bootstrap). Additional members can be managed in the
  // Supabase `approved_members` table via the is_email_approved() function.
  const APPROVED_EMAILS = [
    "hassainn.mcsa@gmail.com",
    "nhussain.hpt@gmail.com",
    "mehaboobn1@gmail.com",
  ];
  const MIN_PASSWORD = 6;

  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) return; // gate off until configured

  const approved = new Set(APPROVED_EMAILS.map((e) => String(e).trim().toLowerCase()));

  const style = document.createElement("style");
  style.textContent = `
    #auth-gate{position:fixed;inset:0;z-index:99999;display:grid;place-items:center;padding:20px;
      background:radial-gradient(circle at 80% 0%,#123,#0e1722);font-family:Inter,ui-sans-serif,system-ui,sans-serif}
    #auth-gate .auth-card{width:min(400px,100%);background:#fff;border-radius:22px;padding:30px;box-shadow:0 34px 90px rgba(0,0,0,.4)}
    #auth-gate .auth-brand{font-weight:800;letter-spacing:2px;color:#14251f}
    #auth-gate .auth-brand b{color:#0aa879}
    #auth-gate h2{margin:16px 0 6px;color:#14251f;font-size:22px}
    #auth-gate p{color:#5b6b64;font-size:14px;line-height:1.5;margin:0}
    #auth-gate label{display:block;margin-top:14px;font-size:12px;font-weight:700;color:#5b6b64;letter-spacing:.3px}
    #auth-gate input{width:100%;box-sizing:border-box;margin:6px 0 0;min-height:48px;padding:0 14px;
      border:1px solid #e4ece8;border-radius:13px;font:inherit;background:#f9fbfa;color:#14251f}
    #auth-gate .auth-btn{width:100%;min-height:48px;margin-top:18px;border:0;border-radius:13px;background:#1fcf96;color:#073f2e;font:800 15px/1 inherit;cursor:pointer}
    #auth-gate .auth-btn:disabled{opacity:.6;cursor:default}
    #auth-gate .auth-link{margin-top:14px;background:none;border:0;color:#0aa879;font-weight:700;cursor:pointer}
    #auth-gate .auth-fine{margin-top:16px;font-size:11px;color:#98a8a2}`;
  document.head.appendChild(style);

  const gate = document.createElement("div");
  gate.id = "auth-gate";
  gate.innerHTML =
    '<form class="auth-card" id="auth-form">' +
    '<div class="auth-brand">ALPHA <b>SWING</b></div>' +
    "<h2>Member access</h2>" +
    '<p id="auth-msg">Sign in with your approved email and password.</p>' +
    '<label for="auth-email">Email</label>' +
    '<input id="auth-email" type="email" placeholder="you@email.com" autocomplete="email" required>' +
    '<label for="auth-password">Password</label>' +
    '<input id="auth-password" type="password" placeholder="Your password" autocomplete="current-password" required minlength="' + MIN_PASSWORD + '">' +
    '<button class="auth-btn" id="auth-submit" type="submit">Sign in</button>' +
    '<button class="auth-link" id="auth-signout" type="button" hidden>Sign out</button>' +
    '<p class="auth-fine">First time? Your password is set on first sign-in. Access is limited to approved members. Educational research only — not investment advice.</p>' +
    "</form>";

  const mount = () => document.body && document.body.appendChild(gate);
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);

  const el = (id) => gate.querySelector(id);
  const setMsg = (text) => { const m = el("#auth-msg"); if (m) m.textContent = text; };

  const loadScript = (src) =>
    new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("load failed"));
      document.head.appendChild(s);
    });

  (async () => {
    try {
      await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js");
    } catch {
      setMsg("Could not load the login service. Check your connection and refresh.");
      return;
    }
    const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
    });
    const openApp = () => { gate.remove(); style.remove(); };

    // Approval is managed in Supabase: is_email_approved() checks the
    // approved_members table without exposing the list. The hardcoded set is a
    // bootstrap fallback so approved members can't be locked out if the RPC is missing.
    const isApproved = async (rawEmail) => {
      const addr = String(rawEmail || "").trim().toLowerCase();
      if (!addr) return false;
      if (approved.has(addr)) return true;
      try {
        const { data, error } = await client.rpc("is_email_approved", { check_email: addr });
        return !error && data === true;
      } catch {
        return false;
      }
    };

    const applyMember = (user) => {
      const email = String(user.email || "").toLowerCase();
      const name = (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name)) || "";
      try { localStorage.setItem("alpha-member", JSON.stringify({ email, name })); } catch {}
      if (typeof window.applyMember === "function") window.applyMember();
    };

    // Called on load and on every auth state change: if a signed-in session
    // belongs to an approved member, open the app; otherwise sign it out.
    const evaluate = async () => {
      const { data } = await client.auth.getSession();
      const user = data && data.session && data.session.user;
      const email = user && String(user.email || "").toLowerCase();
      if (!email) return false;
      if (await isApproved(email)) {
        applyMember(user);
        openApp();
        return true;
      }
      setMsg(email + " is not an approved member. Ask the admin to add your email.");
      const out = el("#auth-signout");
      if (out) out.hidden = false;
      await client.auth.signOut();
      return false;
    };

    client.auth.onAuthStateChange(() => evaluate());
    await evaluate();

    el("#auth-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = String(el("#auth-email").value || "").trim().toLowerCase();
      const password = String(el("#auth-password").value || "");
      if (!email) { setMsg("Enter your email."); return; }
      if (password.length < MIN_PASSWORD) { setMsg("Password must be at least " + MIN_PASSWORD + " characters."); return; }
      if (!(await isApproved(email))) { setMsg("That email is not on the approved member list."); return; }

      const button = el("#auth-submit");
      button.disabled = true;
      button.textContent = "Signing in…";
      try {
        // 1) Try a normal password sign-in.
        const signIn = await client.auth.signInWithPassword({ email, password });
        if (!signIn.error && signIn.data && signIn.data.session) {
          applyMember(signIn.data.session.user);
          openApp();
          return;
        }
        // 2) Wrong password OR the account doesn't exist yet. Try to register
        //    (first-time set-password). Email auto-confirm returns a session.
        const signUp = await client.auth.signUp({ email, password });
        if (!signUp.error && signUp.data && signUp.data.session) {
          applyMember(signUp.data.session.user);
          openApp();
          return;
        }
        // 3) Account already exists but sign-in failed = wrong password.
        //    (GoTrue returns a user with an empty identities[] for an existing email.)
        const existing =
          (signUp.data && signUp.data.user && Array.isArray(signUp.data.user.identities) && signUp.data.user.identities.length === 0) ||
          /already registered|already exists/i.test((signUp.error && signUp.error.message) || "");
        if (existing) {
          setMsg("Incorrect password for this member. Try again, or ask the admin to reset it.");
        } else {
          const msg = (signUp.error && signUp.error.message) || (signIn.error && signIn.error.message) || "Please try again.";
          setMsg("Could not sign in: " + msg);
        }
      } catch (err) {
        setMsg("Could not sign in: " + ((err && err.message) || "please try again shortly."));
      } finally {
        button.disabled = false;
        button.textContent = "Sign in";
      }
    });

    el("#auth-signout").addEventListener("click", async () => {
      await client.auth.signOut();
      try { localStorage.removeItem("alpha-member"); } catch {}
      if (typeof window.applyMember === "function") window.applyMember();
      setMsg("Signed out. Sign in with your approved email and password.");
      el("#auth-signout").hidden = true;
    });
  })();
})();
