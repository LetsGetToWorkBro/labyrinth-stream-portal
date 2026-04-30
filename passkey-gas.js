// =============================================================================
// PASSKEY / WebAuthn — Google Apps Script (GAS) Backend Additions
// =============================================================================
// STEP 1: Add these 4 cases to your doGet() switch statement:
//
//   case 'getPasskeyRegOptions':    return jsonRes(handleGetPasskeyRegOptions(data));
//   case 'savePasskeyCredential':   return jsonRes(handleSavePasskeyCredential(data));
//   case 'getPasskeyAuthChallenge': return jsonRes(handleGetPasskeyAuthChallenge(data));
//   case 'verifyPasskeyAuth':       return jsonRes(handleVerifyPasskeyAuth(data));
//
// STEP 2: Run setupPasskeySheets() once manually from the GAS editor
//         to create the Passkeys and PasskeyChallenges sheets.
//
// STEP 3: Update the two lines marked with "adjust to your GAS" below
//         to match your actual getMemberByEmail() and createSessionToken() functions.
// =============================================================================

function setupPasskeySheets() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss.getSheetByName('Passkeys')) {
    const s = ss.insertSheet('Passkeys');
    s.getRange(1,1,1,4).setValues([['email','credentialId','userIdB64','createdAt']]);
  }
  if (!ss.getSheetByName('PasskeyChallenges')) {
    const s = ss.insertSheet('PasskeyChallenges');
    s.getRange(1,1,1,4).setValues([['challengeB64','email','expiresAt','type']]);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function _generateChallenge() {
  const bytes = Array.from({length:32}, () => Math.floor(Math.random() * 256));
  return Utilities.base64EncodeWebSafe(bytes).replace(/=/g,'');
}

function _storeChallenge(challengeB64, email, type) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PasskeyChallenges');
  if (!sh) return;
  const expires = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  sh.appendRow([challengeB64, email || '', expires, type]);
}

function _consumeChallenge(challengeB64, type) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PasskeyChallenges');
  if (!sh) return { ok: false };
  const data = sh.getDataRange().getValues();
  const now = new Date();
  for (let i = data.length - 1; i >= 1; i--) {
    const [stored, email, expires, storedType] = data[i];
    if (stored === challengeB64 && storedType === type && new Date(expires) > now) {
      sh.deleteRow(i + 1);
      return { ok: true, email };
    }
  }
  return { ok: false };
}

function _cleanExpiredChallenges() {
  try {
    const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('PasskeyChallenges');
    if (!sh) return;
    const data = sh.getDataRange().getValues();
    const now = new Date();
    for (let i = data.length - 1; i >= 1; i--) {
      if (new Date(data[i][2]) < now) sh.deleteRow(i + 1);
    }
  } catch(e) {}
}

function _getAllPasskeyCredentials() {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Passkeys');
  if (!sh) return [];
  const data = sh.getDataRange().getValues();
  return data.slice(1).map(r => ({ email: r[0], credentialId: r[1], userIdB64: r[2] }));
}

// ── Registration Options ──────────────────────────────────────────────────────

function handleGetPasskeyRegOptions(data) {
  const { token, email, name } = data;
  // Verify the user is already logged in
  const session = _verifySessionToken(token);
  if (!session) return { error: 'Not authenticated' };

  const userEmail = email || session.email;
  const challenge = _generateChallenge();
  _storeChallenge(challenge, userEmail, 'reg');
  _cleanExpiredChallenges();

  const userIdB64 = Utilities.base64EncodeWebSafe(userEmail).replace(/=/g,'');
  return { success: true, challenge, userId: userIdB64, email: userEmail, name: name || userEmail };
}

// ── Save Credential After Registration ───────────────────────────────────────

function handleSavePasskeyCredential(data) {
  const { token, credentialId, clientDataJSON } = data;
  const session = _verifySessionToken(token);
  if (!session) return { error: 'Not authenticated' };
  if (!credentialId) return { error: 'Missing credentialId' };

  // Decode & verify clientDataJSON
  try {
    const decoded = JSON.parse(
      Utilities.newBlob(Utilities.base64DecodeWebSafe(clientDataJSON + '==')).getDataAsString()
    );
    // Verify origin
    const allowedOrigins = ['https://stream.labyrinth.vision'];
    if (!allowedOrigins.some(o => decoded.origin.startsWith(o))) {
      return { error: 'Invalid origin: ' + decoded.origin };
    }
    // Consume challenge
    const result = _consumeChallenge(decoded.challenge, 'reg');
    if (!result.ok) return { error: 'Invalid or expired challenge' };
  } catch(e) {
    return { error: 'clientDataJSON parse error: ' + e.message };
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('Passkeys');
  if (!sh) { sh = ss.insertSheet('Passkeys'); sh.appendRow(['email','credentialId','userIdB64','createdAt']); }

  const userEmail = session.email;
  const userIdB64 = Utilities.base64EncodeWebSafe(userEmail).replace(/=/g,'');

  // One passkey per user — replace any existing
  const existing = sh.getDataRange().getValues();
  for (let i = existing.length - 1; i >= 1; i--) {
    if (existing[i][0].toLowerCase() === userEmail.toLowerCase()) sh.deleteRow(i + 1);
  }
  sh.appendRow([userEmail, credentialId, userIdB64, new Date().toISOString()]);
  return { success: true };
}

// ── Auth Challenge ─────────────────────────────────────────────────────────────

function handleGetPasskeyAuthChallenge(data) {
  const challenge = _generateChallenge();
  _storeChallenge(challenge, '', 'auth');
  _cleanExpiredChallenges();

  const allCreds = _getAllPasskeyCredentials();
  const allowCredentials = allCreds.map(c => ({
    id: c.credentialId,
    transports: ['internal']
  }));

  return { success: true, challenge, allowCredentials };
}

// ── Verify Auth Assertion ──────────────────────────────────────────────────────

function handleVerifyPasskeyAuth(data) {
  const { credentialId, clientDataJSON } = data;
  if (!credentialId || !clientDataJSON) return { error: 'Missing assertion data' };

  // 1. Decode clientDataJSON
  let parsed;
  try {
    parsed = JSON.parse(
      Utilities.newBlob(Utilities.base64DecodeWebSafe(clientDataJSON + '==')).getDataAsString()
    );
  } catch(e) { return { error: 'Failed to parse clientDataJSON' }; }

  // 2. Verify type
  if (parsed.type !== 'webauthn.get') return { error: 'Invalid assertion type' };

  // 3. Verify origin
  const allowedOrigins = ['https://stream.labyrinth.vision'];
  if (!allowedOrigins.some(o => parsed.origin.startsWith(o))) {
    return { error: 'Invalid origin: ' + parsed.origin };
  }

  // 4. Consume challenge (prevents replay attacks)
  const challengeResult = _consumeChallenge(parsed.challenge, 'auth');
  if (!challengeResult.ok) return { error: 'Invalid or expired challenge. Please try again.' };

  // 5. Look up credential
  const allCreds = _getAllPasskeyCredentials();
  const match = allCreds.find(c => c.credentialId === credentialId);
  if (!match) return { error: 'Passkey not recognized. Please register first via password login.' };

  const userEmail = match.email;

  // 6. Get member & issue session
  // *** ADJUST these two lines to match your GAS function names ***
  try {
    const member = getMemberByEmail(userEmail);      // <-- your existing function
    if (!member) return { error: 'Member account not found for ' + userEmail };

    const sessionToken = createSessionToken(userEmail); // <-- your existing function

    return {
      success: true,
      token: sessionToken,
      email: userEmail,
      name: member.name,
      member: member
    };
  } catch(e) {
    return { error: 'Login error: ' + e.message };
  }
}

// ── Session Verification Helper ───────────────────────────────────────────────
// Replace this with your actual token verification if you have one already.

function _verifySessionToken(token) {
  if (!token) return null;
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const sh = ss.getSheetByName('Sessions') || ss.getSheetByName('Tokens');
    if (!sh) return null;
    const data = sh.getDataRange().getValues();
    const now = new Date();
    for (let i = 1; i < data.length; i++) {
      const [storedToken, email, expires] = data[i];
      if (storedToken === token && new Date(expires) > now) return { email };
    }
    return null;
  } catch(e) { return null; }
}
