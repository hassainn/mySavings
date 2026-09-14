/* Member access gate — Supabase email + password login + approved allow-list.
 *
 * The app is a static site, so this gates the UI experience. It becomes ACTIVE
 * only once SUPABASE_URL and SUPABASE_ANON_KEY are filled in below.
 *
 * Login: email + password. First sign-in for a NEW approved email sets the
 * password automatically (project has email auto-confirm on, so no confirmation
 * email is needed). Sessions are persisted and auto-refreshed, so members stay
 * signed in.
 *
 * "Forgot / set password": sends a one-time reset link. This is how an account
 * that already existed WITHOUT a password (e.g. left over from the old magic-link
 * login) sets its first password. Requires the site URL to be listed under
 * Supabase → Authentication → URL Configuration (Site URL + Redirect URLs).
 *
 * Only approved emails (the bootstrap set below OR the Supabase approved_members
 * table via is_email_approved()) can sign in, register, or request a reset.
 */
(function () {
  "use strict";

  const SUPABASE_URL = "https://edmvmyogbfxrbxhkqoag.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_abFsuEay_0vkvZPbVJotGQ_BFWc4Ep4"; // publishable (browser-safe)
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
    #auth-gate .auth-link{margin-top:14px;background:none;border:0;color:#0aa879;font-weight:700;cursor:pointer;padding:0;font-size:13px}
    #auth-gate .auth-fine{margin-top:16px;font-size:11px;color:#98a8a2}`;
  document.head.appendChild(style);

  const gate = document.createElement("div");
  gate.id = "auth-gate";
  gate.innerHTML =
    '<div class="auth-card">' +
    '<div class="auth-brand">ALPHA <b>SWING</b></div>' +
    '<div id="auth-login">' +
    "<h2>Member access</h2>" +
    '<p id="auth-msg">Sign in with your approved email and password.</p>' +
    '<form id="auth-form">' +
    '<label for="auth-email">Email</label>' +
    '<input id="auth-email" type="email" placeholder="you@email.com" autocomplete="email" required>' +
    '<label for="auth-password">Password</label>' +
    '<input id="auth-password" type="password" placeholder="Your password" autocomplete="current-password" required minlength="' + MIN_PASSWORD + '">' +
    '<button class="auth-btn" id="auth-submit" type="submit">Sign in</button>' +
    "</form>" +
    '<button class="auth-link" id="auth-forgot" type="button">Forgot / set password</button>' +
    '<button class="auth-link" id="auth-signout" type="button" hidden>Sign out</button>' +
    '<p class="auth-fine">First time? Your password is set on first sign-in. Access is limited to approved members. Educational research only — not investment advice.</p>' +
    "</div>" +
    '<div id="auth-recovery" hidden>' +
    "<h2>Set your password</h2>" +
    '<p id="auth-rmsg">Choose a password for your account.</p>' +
    '<form id="auth-rform">' +
    '<label for="auth-newpw">New password</label>' +
    '<input id="auth-newpw" type="password" placeholder="At least ' + MIN_PASSWORD + ' characters" autocomplete="new-password" required minlength="' + MIN_PASSWORD + '">' +
    '<button class="auth-btn" id="auth-rsubmit" type="submit">Save password</button>' +
    "</form>" +
    '<button class="auth-link" id="auth-rcancel" type="button">Back to sign in</button>' +
    "</div>" +
    "</div>";

  const mount = () => document.body && document.body.appendChild(gate);
  if (document.body) mount();
  else document.addEventListener("DOMContentLoaded", mount);

  const el = (id) => gate.querySelector(id);
  const setMsg = (text) => { const m = el("#auth-msg"); if (m) m.textContent = text; };
  const setRMsg = (text) => { const m = el("#auth-rmsg"); if (m) m.textContent = text; };

  const loadScript = (src) =>
    new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = src;
      s.onload = resolve;
      s.onerror = () => reject(new Error("load failed"));
      document.head.appendChild(s);
    });

  (async () => {
    // Capture any auth params from the URL BEFORE the Supabase client loads and
    // strips them, so we can detect a recovery link or surface its error.
    const initialHash = (location.hash || "").replace(/^#/, "");
    const initialSearch = (location.search || "").replace(/^\?/, "");
    const urlAuth = (key) => {
      const h = new URLSearchParams(initialHash).get(key);
      return h != null ? h : new URLSearchParams(initialSearch).get(key);
    };
    try {
      await loadScript("https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/dist/umd/supabase.js");
    } catch {
      setMsg("Could not load the login service. Check your connection and refresh.");
      return;
    }
    // detectSessionInUrl:true so the reset link's recovery token is picked up.
    const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    });
    const openApp = () => { gate.remove(); style.remove(); };
    let recovering = false;

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

    const showRecovery = () => {
      const l = el("#auth-login"); const r = el("#auth-recovery");
      if (l) l.hidden = true;
      if (r) r.hidden = false;
    };
    const showLogin = () => {
      const l = el("#auth-login"); const r = el("#auth-recovery");
      if (r) r.hidden = true;
      if (l) l.hidden = false;
    };

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

    client.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") { recovering = true; showRecovery(); return; }
      if (recovering) return; // stay on the set-password step until it's saved
      evaluate();
    });

    // Handle arriving from a reset link: surface any error, else show set-password.
    const urlError = urlAuth("error_description") || urlAuth("error_code") || urlAuth("error");
    const isRecoveryLink = urlAuth("type") === "recovery" || !!urlAuth("access_token") && urlAuth("type") === "recovery";
    if (urlError) {
      showLogin();
      setMsg("Reset link problem: " + decodeURIComponent(String(urlError)).replace(/\+/g, " ") + " — request a fresh link and open it right away.");
      try { history.replaceState({}, "", location.pathname); } catch {}
    } else if (isRecoveryLink) {
      recovering = true;
      showRecovery();
    }
    if (!recovering) await evaluate();

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
        const signIn = await client.auth.signInWithPassword({ email, password });
        if (!signIn.error && signIn.data && signIn.data.session) {
          applyMember(signIn.data.session.user);
          openApp();
          return;
        }
        const signUp = await client.auth.signUp({ email, password });
        if (!signUp.error && signUp.data && signUp.data.session) {
          applyMember(signUp.data.session.user);
          openApp();
          return;
        }
        const existing =
          (signUp.data && signUp.data.user && Array.isArray(signUp.data.user.identities) && signUp.data.user.identities.length === 0) ||
          /already registered|already exists/i.test((signUp.error && signUp.error.message) || "");
        if (existing) {
          setMsg("This email already has an account. Tap “Forgot / set password” below to set your password.");
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

    el("#auth-forgot").addEventListener("click", async () => {
      const email = String(el("#auth-email").value || "").trim().toLowerCase();
      if (!email) { setMsg("Enter your email above first, then tap this again."); return; }
      if (!(await isApproved(email))) { setMsg("That email is not on the approved member list."); return; }
      const link = el("#auth-forgot");
      link.disabled = true;
      const { error } = await client.auth.resetPasswordForEmail(email, {
        redirectTo: location.href.split("#")[0],
      });
      link.disabled = false;
      if (!error) {
        setMsg("Check your email for a link to set your password (it may take a minute — check spam too).");
      } else if (/rate limit/i.test(error.message || "")) {
        setMsg("Too many requests just now — wait a couple of minutes and try again.");
      } else {
        setMsg("Could not send the reset link: " + (error.message || "please try again shortly."));
      }
    });

    el("#auth-rform").addEventListener("submit", async (event) => {
      event.preventDefault();
      const pw = String(el("#auth-newpw").value || "");
      if (pw.length < MIN_PASSWORD) { setRMsg("Password must be at least " + MIN_PASSWORD + " characters."); return; }
      const button = el("#auth-rsubmit");
      button.disabled = true;
      button.textContent = "Saving…";
      try {
        const { error } = await client.auth.updateUser({ password: pw });
        if (error) {
          if (/session|missing|jwt|not authenticated/i.test(error.message || "")) {
            setRMsg("This reset link expired or was already used. Go back and request a fresh one, then open it right away.");
          } else {
            setRMsg("Could not save: " + (error.message || "try again."));
          }
          return;
        }
        try { history.replaceState({}, "", location.pathname + location.search); } catch {}
        recovering = false;
        setRMsg("Password saved. Signing you in…");
        const ok = await evaluate();
        if (!ok) { showLogin(); setMsg("Password saved. Sign in with your email and new password."); }
      } catch (err) {
        setRMsg("Could not save: " + ((err && err.message) || "try again."));
      } finally {
        button.disabled = false;
        button.textContent = "Save password";
      }
    });

    el("#auth-rcancel").addEventListener("click", () => {
      recovering = false;
      try { history.replaceState({}, "", location.pathname + location.search); } catch {}
      showLogin();
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
