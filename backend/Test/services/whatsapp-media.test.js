import assert from 'assert';
import fs from 'fs';
import path from 'path';
import test, { before } from 'node:test';

import { useTestDb } from '../helpers/db.js';
import db from '../../src/core/database.js';
import whatsappService, { MEDIA_DIR, mediaKind } from '../../src/services/whatsapp.service.js';
import { pruneOldRows } from '../../src/services/retention.service.js';

before(() => useTestDb('whatsapp-media'));

test('each file goes as WhatsApp shows it; the text rides as the first caption (audio takes none)', async () => {
  assert.deepStrictEqual(['image/jpeg', 'image/png', 'video/mp4', 'audio/mpeg', 'application/pdf', 'text/plain', 'image/webp', 'image/gif']
    .map(mediaKind), ['image', 'image', 'video', 'audio', 'document', 'document', 'document', 'document']);

  const calls = [];
  const saved = { sock: whatsappService.sock, status: whatsappService.status };
  whatsappService.sock = {
    onWhatsApp: async (phone) => [{ exists: true, jid: `${phone}@s.whatsapp.net` }],
    sendMessage: async (jid, content) => { calls.push(content); },
  };
  whatsappService.status = 'open';
  try {
    await whatsappService.sendMessage('919876543210', 'Hi', [
      { file: 'a.pdf', name: 'Report.pdf', mime: 'application/pdf' },
      { file: 'b.jpg', name: 'b.jpg', mime: 'image/jpeg' },
    ]);
    assert.deepStrictEqual(calls[0], { document: { url: path.join(MEDIA_DIR, 'a.pdf') }, mimetype: 'application/pdf', fileName: 'Report.pdf', caption: 'Hi' });
    assert.deepStrictEqual(calls[1], { image: { url: path.join(MEDIA_DIR, 'b.jpg') }, caption: undefined });

    calls.length = 0;
    await whatsappService.sendMessage('919876543210', 'Listen', [{ file: '../../etc/passwd.mp3', name: 'v.mp3', mime: 'audio/mpeg' }]);
    assert.deepStrictEqual(calls[0], { text: 'Listen' });
    assert.deepStrictEqual(calls[1], { audio: { url: path.join(MEDIA_DIR, 'passwd.mp3') }, mimetype: 'audio/mpeg', ptt: false },
      'a stored name can never point outside the media folder');
  } finally {
    Object.assign(whatsappService, saved);
  }
});

test('retention deletes attachment files no message refers to, after an hour', async () => {
  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  for (const name of ['kept.pdf', 'orphan.pdf', 'fresh.pdf']) fs.writeFileSync(path.join(MEDIA_DIR, name), 'x');
  for (const name of ['kept.pdf', 'orphan.pdf']) fs.utimesSync(path.join(MEDIA_DIR, name), old, old);
  await db.run("INSERT INTO whatsapp_messages (recipient, instance_ids, body, status, media) VALUES ('owner', ',1,', 'x', 'sent', ?)",
    [JSON.stringify([{ file: 'kept.pdf', name: 'k.pdf', mime: 'application/pdf' }])]);

  await pruneOldRows();

  assert.deepStrictEqual(fs.readdirSync(MEDIA_DIR).filter((n) => n.endsWith('.pdf')).sort(), ['fresh.pdf', 'kept.pdf']);
});
