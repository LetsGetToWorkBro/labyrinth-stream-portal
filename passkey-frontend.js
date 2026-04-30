/* ═══════════════════════════════════════════════════════════════════════════
   PASSKEY / WebAuthn — Frontend additions for stream.labyrinth.vision
   ───────────────────────────────────────────────────────────────────────────
   INSERTION POINT: Paste this entire block right after your doLogin() function
   in index.html. Then find the button-wiring block and change it per the
   README instructions below.
   ═══════════════════════════════════════════════════════════════════════════ */

// ── Base64url helpers ─────────────────────────────────────────────────────────
function _b64urlToBytes(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(b64.length + (4 - b64.length % 4) % 4, '=');
  return Uint8Array.from(atob(padded), c => c.charCodeAt(0));
}
function _bytesToB64url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── Clear login error helper ──────────────────────────────────────────────────
function clearLoginError() {
  const el = document.getElementById('loginError') || document.querySelector('.login-error');
  if (el) el.textContent = '';
}

// ── Passkey Authentication ────────────────────────────────────────────────────
async function doPasskeyLogin() {
  if (!window.PublicKeyCredential || !navigator.credentials) {
    showLoginError('Passkeys are not supported in this browser. Please use the password form below.');
    return;
  }

  const btn = document.getElementById('btnBiometric');
  const origHTML = btn?.innerHTML;
  if (btn) { btn.disabled = true; btn.textContent = 'Verifying…'; }
  clearLoginError();

  try {
    // 1. Get a fresh challenge + registered credential IDs from GAS
    const opts = await gas('getPasskeyAuthChallenge', {});
    if (opts.error) { showLoginError(opts.error || 'Passkey sign-in unavailable.'); return; }

    const challenge = _b64urlToBytes(opts.challenge);
    const allowCredentials = (opts.allowCredentials || []).map(c => ({
      type: 'public-key',
      id: _b64urlToBytes(c.id),
      transports: c.transports || ['internal']
    }));

    // 2. Ask the OS for a biometric assertion
    const assertion = await navigator.credentials.get({
      publicKey: {
        challenge,
        rpId: 'stream.labyrinth.vision',
        allowCredentials,
        userVerification: 'required',
        timeout: 90000
      }
    });

    // 3. Send assertion to GAS to verify & get a session
    const res = await gas('verifyPasskeyAuth', {
      credentialId:      _bytesToB64url(new Uint8Array(assertion.rawId)),
      clientDataJSON:    _bytesToB64url(new Uint8Array(assertion.response.clientDataJSON)),
      authenticatorData: _bytesToB64url(new Uint8Array(assertion.response.authenticatorData)),
      signature:         _bytesToB64url(new Uint8Array(assertion.response.signature)),
      userHandle: assertion.response.userHandle
        ? _bytesToB64url(new Uint8Array(assertion.response.userHandle)) : null
    });

    if (res.success) {
      SESSION = {
        token: res.token,
        name: res.name || res.member?.name,
        email: res.email,
        belt: res.member?.belt || 'white',
        streak: res.member?.currentStreak || 0,
        role: res.member?.role,
        isAdmin: res.member?.isAdmin || false,
        familyMembers: res.familyMembers,
        member: res.member
      };
      applyBeltTheme(SESSION.belt);
      updateHeaderProfile();
      document.getElementById('page-login').style.display = 'none';
      document.getElementById('app-shell').style.display = 'flex';
      await loadAllData();
    } else {
      showLoginError(res.error || 'Passkey verification failed. Try your password.');
    }
  } catch (err) {
    if (err.name === 'NotAllowedError') {
      showLoginError('Authentication was cancelled or timed out.');
    } else if (err.name === 'InvalidStateError') {
      showLoginError('No passkey found on this device. Log in with your password first, then set up Face ID.');
    } else if (err.name === 'SecurityError') {
      showLoginError('Passkey security error — check that you are on stream.labyrinth.vision.');
    } else {
      console.error('[Passkey auth error]', err);
      showLoginError('Face ID / Fingerprint login failed. Use your password instead.');
    }
  } finally {
    if (btn) { btn.disabled = false; if (origHTML) btn.innerHTML = origHTML; }
  }
}

// ── Passkey Registration ──────────────────────────────────────────────────────
async function registerPasskey() {
  if (!SESSION?.token || !window.PublicKeyCredential) return;

  try {
    const opts = await gas('getPasskeyRegOptions', {
      token: SESSION.token,
      email: SESSION.email,
      name: SESSION.name
    });
    if (opts.error || !opts.challenge) { console.warn('Passkey reg opts failed:', opts.error); return; }

    const cred = await navigator.credentials.create({
      publicKey: {
        challenge: _b64urlToBytes(opts.challenge),
        rp: { id: 'stream.labyrinth.vision', name: 'Labyrinth BJJ' },
        user: {
          id: _b64urlToBytes(opts.userId),
          name: SESSION.email,
          displayName: SESSION.name
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7  },   // ES256
          { type: 'public-key', alg: -257 }   // RS256
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',  // device biometric only
          userVerification: 'required',
          residentKey: 'preferred'
        },
        timeout: 60000,
        attestation: 'none'
      }
    });

    const res = await gas('savePasskeyCredential', {
      token: SESSION.token,
      credentialId:      _bytesToB64url(new Uint8Array(cred.rawId)),
      clientDataJSON:    _bytesToB64url(new Uint8Array(cred.response.clientDataJSON)),
      attestationObject: _bytesToB64url(new Uint8Array(cred.response.attestationObject))
    });

    document.getElementById('passkeyBanner')?.remove();

    if (res.success) {
      const t = document.createElement('div');
      t.style.cssText = `
        position:fixed;bottom:88px;left:50%;transform:translateX(-50%);z-index:9999;
        background:rgba(22,163,74,.92);color:#fff;font-weight:700;font-size:13px;
        padding:10px 20px;border-radius:10px;box-shadow:0 4px 20px rgba(0,0,0,.45);
        pointer-events:none;animation:fadeIn .25s ease;white-space:nowrap;
      `;
      t.textContent = '\u2713 Face ID / Fingerprint set up \u2014 use it next time!';
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 5000);
    }
  } catch (err) {
    document.getElementById('passkeyBanner')?.remove();
    if (err.name !== 'NotAllowedError') console.warn('[Passkey reg]', err.name, err.message);
  }
}

// ── Post-login passkey registration prompt ────────────────────────────────────
function promptPasskeyRegistration() {
  if (!window.PublicKeyCredential) return;
  if (sessionStorage.getItem('pkPrompted')) return;
  sessionStorage.setItem('pkPrompted', '1');

  PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable?.().then(avail => {
    if (!avail) return;

    const banner = document.createElement('div');
    banner.id = 'passkeyBanner';
    banner.style.cssText = `
      position:fixed;bottom:0;left:0;right:0;z-index:9000;
      background:rgba(10,12,20,0.97);
      border-top:1px solid rgba(var(--th-rgb),.25);
      padding:14px 20px;
      display:flex;align-items:center;gap:12px;
      box-shadow:0 -8px 32px rgba(0,0,0,.5);
      animation:fadeIn .3s ease;
    `;
    banner.innerHTML = `
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none"
        stroke="var(--th)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
        <path d="M9 12l2 2 4-4"/>
      </svg>
      <div style="flex:1;min-width:0;">
        <div style="font-size:13px;font-weight:800;color:#fff;letter-spacing:-.01em;">
          Enable Face ID / Fingerprint?
        </div>
        <div style="font-size:11px;color:var(--muted);margin-top:2px;">
          Skip the password \u2014 one tap gets you in next time.
        </div>
      </div>
      <button id="btnSetupPasskey"
        style="background:rgba(var(--th-rgb),.15);border:1px solid rgba(var(--th-rgb),.35);
               color:var(--th);padding:8px 16px;border-radius:8px;font-weight:800;
               font-size:12px;cursor:pointer;white-space:nowrap;font-family:inherit;">
        Set Up
      </button>
      <button onclick="document.getElementById('passkeyBanner')?.remove();"
        style="background:transparent;border:none;color:var(--muted);
               font-size:22px;cursor:pointer;padding:0 2px;line-height:1;font-family:inherit;">
        \u00d7
      </button>
    `;
    document.body.appendChild(banner);
    document.getElementById('btnSetupPasskey')?.addEventListener('click', registerPasskey);
    setTimeout(() => banner?.remove(), 15000);
  });
}
