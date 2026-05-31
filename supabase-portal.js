/**
 * supabase-portal.js — Supabase Auth + Data layer for stream.labyrinth.vision
 *
 * Replaces the GAS-based login with real Supabase Auth.
 * The same sb-* session cookie is shared across *.labyrinth.vision because
 * the main app (app.labyrinth.vision) sets it with domain=.labyrinth.vision.
 *
 * Load order in index.html:
 *   1. <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js">
 *   2. <script src="supabase-portal.js">
 *   3. (rest of existing inline script, with doLogin/loadAllData overridden below)
 */

'use strict';

/* ── Config ─────────────────────────────────────────────────────── */
const SUPABASE_URL      = 'https://bphlwgixwqxxsqsiuzpk.supabase.co';
// anon key is safe client-side — RLS policies control access
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJwaGx3Z2l4d3F4eHNxc2l1enBrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzU4MzQ1MTMsImV4cCI6MjA5MTQxMDUxM30.gB5TyCP2RsrF4b3QGnBoJX-xIKsfdMrUxZR4P_ERSBI';

/* ── Init Supabase client ────────────────────────────────────────── */
// @supabase/supabase-js UMD exposes window.supabase
const _sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    storageKey:         'sb-labyrinth-auth',      // must match main app
    storage:            window.localStorage,
    autoRefreshToken:   true,
    persistSession:     true,
    detectSessionInUrl: true,
    flowType:           'pkce',
  },
});

/* ── Session & redirect helpers ──────────────────────────────────── */
// After login, redirect to the originally requested page (or /).
const REDIRECT_KEY = 'sb_portal_redirect';

function saveIntendedUrl() {
  const url = window.location.href;
  // Don't save the login page itself
  if (!url.includes('#login') && !url.includes('access_token')) {
    sessionStorage.setItem(REDIRECT_KEY, url);
  }
}

function getIntendedUrl() {
  return sessionStorage.getItem(REDIRECT_KEY) || window.location.origin;
}

function clearIntendedUrl() {
  sessionStorage.removeItem(REDIRECT_KEY);
}

/* ══════════════════════════════════════════════════════════════════
   SUPABASE AUTH  —  overrides the GAS-based doLogin()
   ══════════════════════════════════════════════════════════════════ */

/**
 * Main login handler — replaces the GAS doLogin() in index.html.
 * Called by the "Sign In" button.
 */
window.doSupabaseLogin = async function doSupabaseLogin() {
  const emailEl  = document.querySelector('#loginEmail')    || document.querySelector('input[type="email"]');
  const passEl   = document.querySelector('#loginPassword') || document.querySelector('input[type="password"]');
  const loginBtn = document.getElementById('btnSignIn') || document.querySelector('.btn-secondary');

  const email    = (emailEl?.value || '').trim();
  const password = (passEl?.value  || '').trim();

  clearLoginError();

  if (!email || !password) {
    showLoginError('Email and password are required.');
    return;
  }

  if (loginBtn) { loginBtn.disabled = true; loginBtn.textContent = 'Signing in…'; }

  const { data, error } = await _sb.auth.signInWithPassword({ email, password });

  if (loginBtn) { loginBtn.disabled = false; loginBtn.textContent = 'Sign In'; }

  if (error) {
    const msgs = {
      'Invalid login credentials': 'Incorrect email or password.',
      'Email not confirmed':       'Please check your email for a confirmation link.',
    };
    showLoginError(msgs[error.message] || error.message || 'Sign in failed.');
    return;
  }

  // Build SESSION object from Supabase user + member_profiles
  await _buildSessionFromSupabase(data.session, data.user);
  _afterLogin();
};

/**
 * Check for an existing Supabase session on page load.
 * If logged in, skip the login screen entirely.
 */
window.checkExistingSession = async function checkExistingSession() {
  // First: handle email invite / magic link tokens in the URL
  const hashParams = new URLSearchParams(window.location.hash.slice(1));
  if (hashParams.get('access_token')) {
    const { data, error } = await _sb.auth.getSession();
    if (!error && data.session) {
      await _buildSessionFromSupabase(data.session, data.session.user);
      window.history.replaceState(null, '', window.location.pathname);
      _afterLogin();
      return;
    }
  }

  // Otherwise check localStorage for an existing session
  const { data: { session }, error } = await _sb.auth.getSession();
  if (!error && session) {
    await _buildSessionFromSupabase(session, session.user);
    _afterLogin();
  }
  // else: stay on login screen
};

/** Build the global SESSION object from a Supabase session + member_profiles row. */
async function _buildSessionFromSupabase(session, user) {
  // Fetch member profile for belt/XP/check-in count
  const { data: profile } = await _sb
    .from('member_profiles')
    .select('*')
    .eq('id', user.id)
    .single();

  window.SESSION = {
    // Keep GAS-compatible shape so existing code (applyBeltTheme, updateHeaderProfile, etc.) works
    token:         session.access_token,
    name:          profile?.name  || user.user_metadata?.full_name || user.email,
    email:         user.email,
    belt:          profile?.belt  || 'white',
    stripes:       profile?.stripes || 0,
    checkinCount:  profile?.checkin_count || 0,
    xp:            profile?.xp || 0,
    level:         profile?.level || 1,
    streak:        0,   // not stored in Supabase yet — GAS still owns this
    role:          profile?.role  || 'member',
    isAdmin:       profile?.role === 'admin' || profile?.role === 'owner',
    familyMembers: [],
    member:        profile || {},
    // Supabase-specific
    sbUserId:      user.id,
    sbSession:     session,
  };
}

/** Called after SESSION is populated to show the app shell. */
function _afterLogin() {
  if (typeof applyBeltTheme === 'function') applyBeltTheme(window.SESSION?.belt || 'white');
  if (typeof updateHeaderProfile === 'function') updateHeaderProfile();

  // Show mobile warning if needed
  if (/Mobi|Android|iPhone|iPad|iPod/i.test(navigator.userAgent)) {
    _showMobileWarning();
  }

  document.getElementById('page-login').style.display = 'none';
  document.getElementById('app-shell').style.display  = 'flex';

  clearIntendedUrl();
  if (typeof loadAllData === 'function') loadAllData();
}

function _showMobileWarning() {
  if (document.getElementById('mobile-warn-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'mobile-warn-overlay';
  overlay.innerHTML = `
    <div style="position:fixed;inset:0;z-index:9999;
                background:linear-gradient(160deg,#0a0c14 0%,#050608 50%,#08060e 100%);
                display:flex;flex-direction:column;align-items:center;justify-content:center;
                padding:32px 24px;text-align:center;font-family:inherit;">
      <div style="font-size:36px;margin-bottom:20px">⚠️</div>
      <div style="font-size:11px;font-weight:800;text-transform:uppercase;letter-spacing:.12em;
                  color:var(--th);margin-bottom:10px;">Heads Up</div>
      <div style="font-size:20px;font-weight:900;color:#fff;margin-bottom:10px;letter-spacing:-.02em;">
        Live Stream Won't Work Here
      </div>
      <div style="font-size:13px;color:rgba(255,255,255,0.45);max-width:260px;line-height:1.7;margin-bottom:32px;">
        Use the Labyrinth BJJ app for the best experience.
        Live streams and some features won't work on mobile browsers.
      </div>
      <a href="https://app.labyrinth.vision"
         style="display:block;width:100%;max-width:260px;padding:14px;border-radius:12px;
                background:rgba(var(--th-rgb),.8);color:#fff;text-decoration:none;
                font-size:14px;font-weight:800;letter-spacing:.02em;margin-bottom:12px;">
        Take Me to the App
      </a>
      <button onclick="document.getElementById('mobile-warn-overlay').remove()"
              style="background:transparent;border:1px solid rgba(var(--th-rgb),.15);
                     color:rgba(255,255,255,0.3);font-size:12px;font-weight:600;
                     cursor:pointer;padding:8px 20px;border-radius:8px;font-family:inherit;">
        Continue anyway
      </button>
    </div>`;
  document.body.prepend(overlay);
}

/* ── Sign out ────────────────────────────────────────────────────── */
window.doSupabaseSignOut = async function doSupabaseSignOut() {
  await _sb.auth.signOut({ scope: 'global' });
  window.SESSION = null;
  document.getElementById('app-shell').style.display  = 'none';
  document.getElementById('page-login').style.display = '';
};

/* ══════════════════════════════════════════════════════════════════
   REQUEST ACCESS FLOW
   Shows a form that submits to access_requests table in Supabase.
   Admins approve requests in the main app's /admin panel.
   ══════════════════════════════════════════════════════════════════ */
window.showRequestAccess = function showRequestAccess() {
  // Replace login card with request form
  const card = document.querySelector('.login-card');
  if (!card) return;

  card.innerHTML = `
    <div class="login-logo" style="text-align:center;margin-bottom:20px;">
      <div class="login-logo-sub" style="font-size:15px;font-weight:800;color:var(--text);">
        Request Portal Access
      </div>
      <p style="font-size:12px;color:var(--muted);margin:6px 0 0;">
        Members can request access below. An instructor will review and send you an invite.
      </p>
    </div>
    <div id="accessRequestMsg" style="display:none;"></div>
    <div class="form-group">
      <label class="form-label">Full Name</label>
      <input class="form-input" id="reqName" type="text" placeholder="Your name" autocomplete="name">
    </div>
    <div class="form-group">
      <label class="form-label">Email</label>
      <input class="form-input" id="reqEmail" type="email" placeholder="you@example.com" autocomplete="email">
    </div>
    <div class="form-group">
      <label class="form-label">Why do you need access? <span style="color:var(--muted)">(optional)</span></label>
      <textarea class="form-input" id="reqMessage" rows="3" placeholder="I'm a current member at Labyrinth BJJ…"
        style="resize:none;line-height:1.5;"></textarea>
    </div>
    <button id="btnSubmitRequest" onclick="submitAccessRequest()"
      style="width:100%;padding:14px;border-radius:12px;border:1px solid rgba(var(--th-rgb),.4);
             background:rgba(var(--th-rgb),.12);color:var(--th);font-weight:800;font-size:15px;
             font-family:inherit;cursor:pointer;margin-bottom:10px;">
      Request Access
    </button>
    <button onclick="window.location.reload()"
      style="width:100%;background:transparent;border:1px solid rgba(255,255,255,0.08);
             border-radius:12px;padding:12px;color:var(--muted);font-size:13px;
             font-weight:600;cursor:pointer;font-family:inherit;">
      ← Back to Sign In
    </button>
  `;
};

window.submitAccessRequest = async function submitAccessRequest() {
  const name    = (document.getElementById('reqName')?.value    || '').trim();
  const email   = (document.getElementById('reqEmail')?.value   || '').trim();
  const message = (document.getElementById('reqMessage')?.value || '').trim();
  const msg     = document.getElementById('accessRequestMsg');
  const btn     = document.getElementById('btnSubmitRequest');

  if (!name || !email) {
    if (msg) { msg.style.cssText='color:#ef4444;font-size:13px;margin-bottom:12px;display:block;'; msg.textContent='Name and email are required.'; }
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    if (msg) { msg.style.cssText='color:#ef4444;font-size:13px;margin-bottom:12px;display:block;'; msg.textContent='Enter a valid email address.'; }
    return;
  }

  if (btn) { btn.disabled = true; btn.textContent = 'Submitting…'; }

  const { error } = await _sb.from('access_requests').insert({ name, email, message });

  if (error) {
    if (msg) { msg.style.cssText='color:#ef4444;font-size:13px;margin-bottom:12px;display:block;'; msg.textContent=error.message||'Submission failed. Try again.'; }
    if (btn) { btn.disabled = false; btn.textContent = 'Request Access'; }
    return;
  }

  // Show pending screen
  const card = document.querySelector('.login-card');
  if (card) card.innerHTML = `
    <div style="text-align:center;padding:16px 0;">
      <div style="width:60px;height:60px;border-radius:50%;background:rgba(var(--th-rgb),.1);
                  border:2px solid rgba(var(--th-rgb),.3);display:flex;align-items:center;
                  justify-content:center;margin:0 auto 20px;">
        <svg width="26" height="26" viewBox="0 0 24 24" fill="none"
          stroke="var(--th)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
      </div>
      <h3 style="color:var(--text);font-size:17px;font-weight:800;margin:0 0 10px;">Request Submitted</h3>
      <p style="color:var(--muted);font-size:13px;line-height:1.6;">
        We received your request for <strong style="color:var(--th)">${email}</strong>.<br>
        You'll get an email invite once an instructor approves it.
      </p>
    </div>
  `;
};

/* ══════════════════════════════════════════════════════════════════
   STREAM STATUS  —  replaces GAS getStreamStatus polling
   Uses Supabase Realtime for instant updates + 30s polling fallback
   ══════════════════════════════════════════════════════════════════ */
window.loadStreamStatusSupabase = async function loadStreamStatusSupabase() {
  // Fetch from stream_status table
  const { data, error } = await _sb
    .from('stream_status')
    .select('*')
    .order('updated_at', { ascending: false })
    .limit(1)
    .single();

  if (!error && data) {
    // Map to the shape the existing applyStreamData() expects
    const mapped = {
      isLive:    data.is_live,
      videoId:   data.video_id || '',
      className: data.class_name || '',
      instructor: data.instructor || '',
      startedAt: data.started_at || '',
      live:      data.is_live,
    };
    if (typeof applyStreamData === 'function') applyStreamData(mapped);
  } else {
    // Supabase not configured or user not authed — fall back to GAS
    if (typeof gas === 'function') {
      const fallback = await gas('getStreamStatus');
      if (typeof applyStreamData === 'function') applyStreamData(fallback);
    }
  }

  // Supabase Realtime subscription for instant live/offline toggle
  _sb
    .channel('stream-status-changes')
    .on('postgres_changes', {
      event: 'UPDATE',
      schema: 'public',
      table: 'stream_status',
    }, payload => {
      if (payload.new) {
        const d = payload.new;
        if (typeof applyStreamData === 'function') {
          applyStreamData({
            isLive:    d.is_live,
            videoId:   d.video_id || '',
            className: d.class_name || '',
            instructor: d.instructor || '',
            startedAt: d.started_at || '',
            live:      d.is_live,
          });
        }
      }
    })
    .subscribe();

  // 30s polling fallback (covers Realtime websocket failures)
  if (window._streamPollTimer) clearInterval(window._streamPollTimer);
  window._streamPollTimer = setInterval(loadStreamStatusSupabase, 30_000);
};

/* ══════════════════════════════════════════════════════════════════
   SCHEDULE  —  queries GAS (schedule is still GAS-owned)
   Adds a "Next Class" computed card from the raw schedule data.
   ══════════════════════════════════════════════════════════════════ */

/** Format minutes-since-midnight to "h:mm AM/PM CST" */
function _minsToCST(totalMins) {
  const h  = Math.floor(totalMins / 60) % 24;
  const m  = totalMins % 60;
  const ap = h < 12 ? 'AM' : 'PM';
  const h12 = h % 12 || 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ap} CST`;
}

/** Parse a class time string (various formats) to minutes-since-midnight. */
function _parseTimeMins(t) {
  if (!t) return null;
  if (typeof t === 'number' && t > 0 && t < 1) return Math.round(t * 24 * 60);
  const s = String(t).trim();
  const iso = s.match(/\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):/);
  if (iso) { const u = parseInt(iso[1]) * 60 + parseInt(iso[2]); return (u - 8*60 + 1440) % 1440; }
  const m12 = s.match(/(\d{1,2}):(\d{2})\s*(AM|PM)/i);
  if (m12) { let h = parseInt(m12[1]); const mn = parseInt(m12[2]); if (/PM/i.test(m12[3]) && h!==12) h+=12; if (/AM/i.test(m12[3]) && h===12) h=0; return h*60+mn; }
  const m24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (m24) return parseInt(m24[1])*60+parseInt(m24[2]);
  return null;
}

/** Compute and render "Next Class" card from schedule array. */
window.renderNextClass = function renderNextClass(classes) {
  const el = document.getElementById('nextClassCard');
  if (!el) return;

  const DAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
  const now  = new Date();
  // Houston / CST is UTC-6 (CDT) or UTC-5 (CT). Use Intl for correctness.
  const cstNow = new Date(now.toLocaleString('en-US', { timeZone: 'America/Chicago' }));
  const todayIdx = cstNow.getDay();
  const nowMins  = cstNow.getHours() * 60 + cstNow.getMinutes();

  let next = null;
  for (let offset = 0; offset < 7 && !next; offset++) {
    const dayIdx  = (todayIdx + offset) % 7;
    const dayName = DAYS[dayIdx];
    const dayClasses = classes.filter(c =>
      String(c.Day || c.day || '').trim().toLowerCase() === dayName.toLowerCase()
    );
    for (const cls of dayClasses) {
      const mins = _parseTimeMins(cls.Time || cls.time);
      if (mins === null) continue;
      if (offset === 0 && mins <= nowMins) continue; // already passed today
      const title      = String(cls.Title || cls.title || 'Class');
      const instructor = String(cls.Instructor || cls.instructor || 'Anthony Curry');
      const label      = offset === 0 ? 'Today' : offset === 1 ? 'Tomorrow' : dayName;
      next = { label, title, instructor, time: _minsToCST(mins), dayName };
      break;
    }
  }

  if (!next) {
    el.innerHTML = `<div style="color:var(--muted);font-size:12px;">No upcoming classes found.</div>`;
    return;
  }

  el.innerHTML = `
    <div class="schedule-label">${next.label} · Next Class</div>
    <div class="schedule-item" style="padding:8px 0 0;border-bottom:none;">
      <span class="schedule-class" style="font-size:14px;">${next.title}</span>
      <span class="schedule-time">${next.time}</span>
    </div>
    <div style="font-size:11px;color:var(--muted);margin-top:4px;">
      ${next.instructor}
    </div>
  `;
};

/* ══════════════════════════════════════════════════════════════════
   MEMBER PROFILE  —  update header/sidebar after login
   ══════════════════════════════════════════════════════════════════ */
window.updateHeaderProfileSupabase = function updateHeaderProfileSupabase() {
  if (!window.SESSION) return;
  const s = window.SESSION;

  // Enrich any existing updateHeaderProfile() with Supabase data
  const nameEl    = document.getElementById('headerName')   || document.querySelector('.profile-name');
  const beltEl    = document.getElementById('headerBelt')   || document.querySelector('.profile-belt');
  const levelEl   = document.getElementById('headerLevel')  || document.querySelector('.profile-level');
  const xpEl      = document.getElementById('headerXP')     || document.querySelector('.profile-xp');
  const checkinEl = document.getElementById('headerCheckin') || document.querySelector('.profile-checkin');

  if (nameEl)    nameEl.textContent    = s.name || '';
  if (beltEl)    beltEl.textContent    = s.belt ? (s.belt[0].toUpperCase() + s.belt.slice(1)) + ' Belt' : '';
  if (levelEl)   levelEl.textContent   = `Lvl ${s.level ?? 1}`;
  if (xpEl)      xpEl.textContent      = `${s.xp ?? 0} XP`;
  if (checkinEl) checkinEl.textContent = `${s.checkinCount ?? 0} Check-ins`;
};

/* ══════════════════════════════════════════════════════════════════
   BOOT  —  override the inline doLogin and wire up on DOMContentLoaded
   ══════════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', async () => {
  // 1. Override doLogin to use Supabase
  window.doLogin = window.doSupabaseLogin;

  // 2. Wire "Sign In" button to Supabase login
  const signInBtn = document.getElementById('btnSignIn') || document.querySelector('button[onclick*="doLogin"]');
  if (signInBtn) {
    signInBtn.removeAttribute('onclick');
    signInBtn.addEventListener('click', e => { e.preventDefault(); window.doSupabaseLogin(); });
  }

  // 3. Wire Enter key on password field
  const passInput = document.getElementById('loginPassword') || document.querySelector('input[type="password"]');
  if (passInput) {
    passInput.addEventListener('keydown', e => { if (e.key === 'Enter') window.doSupabaseLogin(); });
  }

  // 4. Wire "Request Access" link
  const reqLink = document.getElementById('btnRequestAccess') || document.querySelector('a[href*="request"]');
  if (reqLink) {
    reqLink.removeAttribute('href');
    reqLink.style.cursor = 'pointer';
    reqLink.addEventListener('click', e => { e.preventDefault(); window.showRequestAccess(); });
  }

  // 5. Check for existing Supabase session (shared cookie from main app)
  await window.checkExistingSession();

  // 6. Override stream status polling to use Supabase
  window.loadStreamStatus = window.loadStreamStatusSupabase;

  // 7. Auto-load stream status (no login required for the status badge)
  await window.loadStreamStatusSupabase();
});
