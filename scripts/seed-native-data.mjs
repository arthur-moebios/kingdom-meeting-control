import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const [sourceFile, targetFile] = process.argv.slice(2);
if (!sourceFile || !targetFile) throw new Error('Provide source and native database paths');
if (path.resolve(sourceFile) === path.resolve(targetFile)) throw new Error('Native data must use its own database');
fs.mkdirSync(path.dirname(path.resolve(targetFile)), { recursive: true });
if (!fs.existsSync(targetFile)) {
  const source = new DatabaseSync(sourceFile, { readOnly: true });
  try { source.exec("VACUUM INTO '" + path.resolve(targetFile).replaceAll("'", "''") + "'"); }
  finally { source.close(); }
  const native = new DatabaseSync(targetFile);
  try {
    const row = native.prepare('SELECT json FROM settings WHERE id=1').get();
    if (row) {
      const settings = JSON.parse(row.json);
      settings.meeting = { ...settings.meeting, autoJoin: true, autoStartMeeting: true, joinMode: 'start' };
      settings.share = { ...settings.share, mode: 'automatic', shareAudio: true };
      settings.automations = { ...settings.automations, autoAdmit: true };
      settings.browser = { ...settings.browser, hidden: true };
      native.prepare('UPDATE settings SET json=? WHERE id=1').run(JSON.stringify(settings));
    }
  } finally { native.close(); }
  console.log('Native data imported; original database preserved.');
} else console.log('Existing native data preserved.');
