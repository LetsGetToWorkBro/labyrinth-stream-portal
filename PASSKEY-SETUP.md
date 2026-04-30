# Passkey (Face ID / Fingerprint) Setup Guide

This guide walks through wiring the two new files into your existing `index.html` and GAS backend.

---

## 1. Frontend — `index.html` changes (3 edits)

### Edit A: Add the passkey JS block

Open `index.html`. Find the closing line of your `doLogin()` function (look for `}` after the catch block). **Paste the full contents of `passkey-frontend.js` immediately after it.**

### Edit B: Wire the biometric button separately

Find this line in your button-wiring section:
```js
document.querySelectorAll('.btn-secondary, .btn-biometric').forEach(btn => {
```

Replace it with **two separate listeners**:
```js
// Password login
document.querySelectorAll('.btn-secondary').forEach(btn => {
  if (btn.closest('#app-shell')) return;
  btn.addEventListener('click', e => { e.preventDefault(); doLogin(); });
});

// Face ID / Fingerprint login
document.querySelectorAll('.btn-biometric').forEach(btn => {
  if (btn.closest('#app-shell')) return;
  btn.addEventListener('click', e => { e.preventDefault(); doPasskeyLogin(); });
});
```

### Edit C: Trigger passkey registration prompt after password login

Inside your `doLogin()` success block, after `await loadAllData();`, add:
```js
promotPasskeyRegistration();
```

> After their first password login on a device, a banner will slide up from the bottom asking them to set up Face ID. If they tap "Set Up", the OS biometric prompt fires and the passkey gets registered.

---

## 2. GAS Backend — 4 steps

### Step 1: Copy the code

Open your Apps Script editor → paste the full contents of `passkey-gas.js` at the bottom of your existing script.

### Step 2: Run the sheet setup (once)

In the GAS editor, run `setupPasskeySheets()` manually. This creates:
- **Passkeys** sheet — stores `email | credentialId | userIdB64 | createdAt`
- **PasskeyChallenges** sheet — stores temporary challenges (5-min TTL)

### Step 3: Add the 4 cases to your `doGet()` switch

```js
case 'getPasskeyRegOptions':    return jsonRes(handleGetPasskeyRegOptions(data));
case 'savePasskeyCredential':   return jsonRes(handleSavePasskeyCredential(data));
case 'getPasskeyAuthChallenge': return jsonRes(handleGetPasskeyAuthChallenge(data));
case 'verifyPasskeyAuth':       return jsonRes(handleVerifyPasskeyAuth(data));
```

### Step 4: Update the 2 function calls in `handleVerifyPasskeyAuth`

Find these two lines and replace with your actual GAS function names:
```js
const member = getMemberByEmail(userEmail);      // ← your function
const sessionToken = createSessionToken(userEmail); // ← your function
```

### Step 5: Redeploy as Web App

After adding the code, go to **Deploy → Manage Deployments → Edit** and click **Deploy** to push the updated version.

---

## 3. How it works

```
First time (password login):
  User enters email + password → GAS validates → session issued
  Banner appears: "Enable Face ID?" → User taps Set Up
  Browser asks for biometric → OS verifies → credential stored in GAS Passkeys sheet

Next visits (passkey login):
  User taps gold "Login with Face ID" button
  GAS generates a fresh challenge
  Browser presents saved passkey → OS shows Face ID / Touch ID prompt
  User authenticates with face/finger → browser sends signed assertion
  GAS verifies challenge + looks up credential ID → issues session token
  User is logged in instantly
```

## 4. Security notes

- Challenges are **single-use, 5-minute TTL** (prevents replay attacks)
- **Origin binding** enforced — only `stream.labyrinth.vision` works
- The biometric check is enforced by the **device OS** — the browser never releases the credential without it
- Credential IDs are stored per-member in your Google Sheet
- Full ECDSA signature verification requires a Node.js environment; the security model above is sufficient for a gym portal
