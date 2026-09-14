/* Member access gate — Supabase email magic-link login + approved allow-list.
 *
 * The app is a static site, so this gates the UI experience. It becomes ACTIVE
 * only once SUPABASE_URL and SUPABASE_ANON_KEY are filled in below; until then
 * the site loads normally (so nothing breaks during setup).
 *
 * Setup (free Supabase project):
 *   1. supabase.com → New project (free).
 *   2. Project Settings → API → copy "Project URL" and the "anon"/publishable
 *      key (safe to expose in the browser) into the two constants below.
 *   3. Authentication → Providers → Email → enable "Email" (magic link).
 *   4. Authentication → URL Configuration → set Site URL and add Redirect URLs
 *      for where the app is served (e.g. https://mehaboobfund.in and
 *      https://hassainn.github.io/mySavings/).
 *   5. Add every approved member's email to APPROVED_EMAILS (lowercase).
 *
 * Note: this hides the UI behind login. To make the DATA itself private, the
 * feeds must later move behind Supabase row-level security.
 */
(function () {
  "use strict";

  const SUPABASE_URL = "https://edmvmyogbfxrbxhkqoag.supabase.co";
  const SUPABASE_ANON_KEY = "sb_publishable_abFsuEay_0vkvZPbVJotGQ_BFWc4Ep4"; // publishable (browser-safe)
  const APPROVED_EMAILS = [
    "hassainn.mcsa@gmail.com",
  ];

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
    #auth-gate input{width:100%;box-sizing:border-box;margin:16px 0;min-height:48px;padding:0 14px;
      border:1px solid #e4ece8;border-radius:13px;font:inherit;background:#f9fbfa;color:#14251f}
    #auth-gate .auth-btn{width:100%;min-height:48px;border:0;border-radius:13px;background:#1fcf96;color:#073f2e;font:800 15px/1 inherit;cursor:pointer}
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
    '<p id="auth-msg">Sign in with your approved email to continue.</p>' +
    '<input id="auth-email" type="email" placeholder="you@email.com" autocomplete="email" required>' +
    '<button class="auth-btn" id="auth-submit" type="submit">Email me a login link</button>' +
    '<button class="auth-link" id="auth-signout" type="button" hidden>Sign out</button>' +
    '<p class="auth-fine">Access is limited to approved members. Educational research only — not investment advice.</p>' +
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
    const client = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    const openApp = () => { gate.remove(); style.remove(); };

    const evaluate = async () => {
      const { data } = await client.auth.getSession();
      const user = data && data.session && data.session.user;
      const email = user && String(user.email || "").toLowerCase();
      if (!email) return;
      if (approved.has(email)) {
        const name = (user.user_metadata && (user.user_metadata.full_name || user.user_metadata.name)) || "";
        try { localStorage.setItem("alpha-member", JSON.stringify({ email, name })); } catch {}
        if (typeof window.applyMember === "function") window.applyMember();
        openApp();
        return;
      }
      setMsg(email + " is not an approved member. Ask the admin to add your email.");
      const out = el("#auth-signout");
      if (out) out.hidden = false;
      await client.auth.signOut();
    };

    client.auth.onAuthStateChange(() => evaluate());
    await evaluate();

    el("#auth-form").addEventListener("submit", async (event) => {
      event.preventDefault();
      const email = String(el("#auth-email").value || "").trim().toLowerCase();
      if (!approved.has(email)) { setMsg("That email is not on the approved member list."); return; }
      const button = el("#auth-submit");
      button.disabled = true;
      button.textContent = "Sending…";
      const { error } = await client.auth.signInWithOtp({
        email,
        options: { emailRedirectTo: location.href.split("#")[0] },
      });
      button.disabled = false;
      button.textContent = "Email me a login link";
      setMsg(error ? "Could not send the link. Check the email and try again." : "Check your inbox for a secure login link.");
    });

    el("#auth-signout").addEventListener("click", async () => {
      await client.auth.signOut();
      try { localStorage.removeItem("alpha-member"); } catch {}
      if (typeof window.applyMember === "function") window.applyMember();
      setMsg("Signed out. Sign in with your approved email to continue.");
      el("#auth-signout").hidden = true;
    });
  })();
})();
