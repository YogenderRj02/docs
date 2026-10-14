// ===== Ghar Documents — Google Drive backend (Google Apps Script) =====
// Ye script aapke Google Drive me "Ghar Documents / <Member> / <Folder> / file" banata hai.
// Har request par Firebase login token verify hota hai, isliye sirf aapke app ke users hi use kar sakte hain.
//
// DEPLOY: Deploy > New deployment > Web app | Execute as: Me | Who has access: Anyone
// Code badalne par: Deploy > Manage deployments > Edit > Version: New version > Deploy
// Password reset ke liye appsscript.json (manifest) me cloud-platform scope bhi chahiye (alag file di gayi hai).

const FIREBASE_API_KEY = 'AIzaSyAAIe5981RwbdW4dTnWLajTeDHMbBMQhZs'; // Firebase config ka apiKey
const PROJECT_ID = 'dialog-box-63269';                              // Firebase projectId
const ROOT_NAME = 'Ghar Documents';

// Ek baar editor me "authorize" function Run karo (Drive, internet aur password-reset ki permission ke liye)
function authorize() {
  root_();
  UrlFetchApp.fetch('https://www.google.com');
  ScriptApp.getOAuthToken();
}

function root_() {
  const p = PropertiesService.getScriptProperties();
  const id = p.getProperty('ROOT');
  if (id) { try { return DriveApp.getFolderById(id); } catch (e) {} }
  const it = DriveApp.getFoldersByName(ROOT_NAME);
  const f = it.hasNext() ? it.next() : DriveApp.createFolder(ROOT_NAME);
  p.setProperty('ROOT', f.getId());
  return f;
}
function find_(parent, name) {
  const it = parent.getFoldersByName(name);
  return it.hasNext() ? it.next() : null;
}
function sub_(parent, name) { return find_(parent, name) || parent.createFolder(name); }

function need_(v, label) {
  if (!v || typeof v !== 'string' || !v.trim()) throw new Error(label + ' missing hai');
  return v.trim();
}

function verify_(idToken) {
  need_(idToken, 'Login token');
  const r = UrlFetchApp.fetch(
    'https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + FIREBASE_API_KEY,
    { method: 'post', contentType: 'application/json', payload: JSON.stringify({ idToken: idToken }), muteHttpExceptions: true });
  const j = JSON.parse(r.getContentText());
  if (!j.users || !j.users.length) {
    const why = j.error && j.error.message ? ' (' + j.error.message + ')' : '';
    throw new Error('Login verify nahi hua' + why);
  }
  return j.users[0].localId;
}

// Firestore me is user ka role 'admin' aur active hai ya nahi (user ke apne token se padhta hai)
function isAdmin_(idToken, uid) {
  const r = UrlFetchApp.fetch(
    'https://firestore.googleapis.com/v1/projects/' + PROJECT_ID + '/databases/(default)/documents/users/' + uid,
    { headers: { Authorization: 'Bearer ' + idToken }, muteHttpExceptions: true });
  const j = JSON.parse(r.getContentText());
  const f = j.fields || {};
  return !!(f.role && f.role.stringValue === 'admin' && f.active && f.active.booleanValue === true);
}

// file / folder sach me "Ghar Documents" ke andar hai ya nahi
function under_(item, rootId) {
  let cur = item;
  for (let i = 0; i < 6; i++) {
    const ps = cur.getParents();
    if (!ps.hasNext()) return false;
    cur = ps.next();
    if (cur.getId() === rootId) return true;
  }
  return false;
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const r = JSON.parse(e.postData.contents);
    const uid = verify_(r.idToken);
    const root = root_();
    let res = {};

    if (r.action === 'upload') {
      const memberName = need_(r.memberName, 'Member ka naam');
      const folderName = need_(r.folderName, 'Folder ka naam');
      need_(r.data, 'File data');
      const lock = LockService.getScriptLock();
      lock.waitLock(20000); // do log ek saath upload karein to duplicate folder na bane
      try {
        const folder = sub_(sub_(root, memberName), folderName);
        const blob = Utilities.newBlob(Utilities.base64Decode(r.data), r.mime || 'application/octet-stream', r.name || 'file');
        res = { id: folder.createFile(blob).getId() };
      } finally {
        lock.releaseLock();
      }

    } else if (r.action === 'get') {
      const file = DriveApp.getFileById(need_(r.id, 'File id'));
      if (!under_(file, root.getId())) throw new Error('Allowed nahi');
      const b = file.getBlob();
      res = { data: Utilities.base64Encode(b.getBytes()), mime: b.getContentType() };

    } else if (r.action === 'delete') {
      const file = DriveApp.getFileById(need_(r.id, 'File id'));
      if (under_(file, root.getId())) file.setTrashed(true);

    } else if (r.action === 'rename') {
      const file = DriveApp.getFileById(need_(r.id, 'File id'));
      if (!under_(file, root.getId())) throw new Error('Allowed nahi');
      file.setName(need_(r.name, 'Naya naam'));

    } else if (r.action === 'move') {
      const file = DriveApp.getFileById(need_(r.id, 'File id'));
      if (!under_(file, root.getId())) throw new Error('Allowed nahi');
      const lock = LockService.getScriptLock();
      lock.waitLock(20000);
      try {
        const dest = sub_(sub_(root, need_(r.memberName, 'Member ka naam')), need_(r.folderName, 'Folder ka naam'));
        file.moveTo(dest);
      } finally {
        lock.releaseLock();
      }

    } else if (r.action === 'trashFolder') {
      const m = find_(root, need_(r.memberName, 'Member ka naam'));
      if (m) {
        const t = r.folderName ? find_(m, r.folderName) : m;
        if (t) t.setTrashed(true);
      }

    } else if (r.action === 'resetPassword') {
      if (!isAdmin_(r.idToken, uid)) throw new Error('Sirf admin password reset kar sakta hai');
      const pw = need_(r.password, 'Password');
      if (pw.length < 6) throw new Error('Password 6+ akshar ka hona chahiye');
      const resp = UrlFetchApp.fetch(
        'https://identitytoolkit.googleapis.com/v1/projects/' + PROJECT_ID + '/accounts:update',
        {
          method: 'post', contentType: 'application/json', muteHttpExceptions: true,
          headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), 'x-goog-user-project': PROJECT_ID },
          payload: JSON.stringify({ localId: need_(r.uid, 'User id'), password: pw })
        });
      if (resp.getResponseCode() >= 300) {
        let why = resp.getResponseCode();
        try { why = JSON.parse(resp.getContentText()).error.message; } catch (x) {}
        throw new Error('Password reset nahi hua: ' + why);
      }

    } else {
      throw new Error('Unknown action');
    }
    return out_(Object.assign({ ok: true }, res));
  } catch (err) {
    return out_({ ok: false, error: String(err.message || err) });
  }
}

// Test ke liye: browser me /exec link kholne par ye dikhega
function doGet() { return out_({ ok: true, msg: 'Ghar Documents backend chal raha hai' }); }
