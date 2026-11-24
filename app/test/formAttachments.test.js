/**
 * Tests for form step attachments (processAttachments in
 * src/services/formSubmissions.js and detectFileType in src/utils/imageType.js)
 *
 * The client chooses the contentType and filename of an attachment, so the
 * stored type and extension must come from the file content and match the
 * subtype of the file field.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import sharp from 'sharp';

const { processAttachments } = await import('../src/services/formSubmissions.js');
const { detectFileType } = await import('../src/utils/imageType.js');

const FIELDS = [
  { type: 'text', label: 'Name' },
  { type: 'file', label: 'Photo', fileSubtype: 'image' },
  { type: 'file', label: 'Document', fileSubtype: 'document' },
  { type: 'file', label: 'Recording', fileSubtype: 'audio' },
  { type: 'file', label: 'Old field' }
];

const png = await sharp({ create: { width: 2, height: 2, channels: 3, background: '#ffffff' } }).png().toBuffer();
const pdf = Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF\n', 'latin1');
const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26), Buffer.from('[Content_Types].xml word/document.xml', 'latin1')]);
const zip = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(26), Buffer.from('payload.exe', 'latin1')]);
const mp3 = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([4, 0, 0, 0, 0, 0, 0]), Buffer.alloc(64)]);
const html = Buffer.from('<html><body><script>alert(1)</script></body></html>\n', 'utf8');
const binary = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x02, 0x01, 0x01, 0x00, 0x00, 0x00]);

/** A valid PNG with "%PDF-" in a tEXt chunk inside the first kilobyte. */
function pngWithPdfMarker() {
  const data = Buffer.from('Comment\0%PDF-1.4', 'latin1');
  const type = Buffer.from('tEXt', 'latin1');
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([type, data])));
  const ihdrEnd = 8 + 4 + 4 + 13 + 4;
  return Buffer.concat([png.subarray(0, ihdrEnd), len, type, data, crc, png.subarray(ihdrEnd)]);
}

const att = (buffer, filename, contentType, fieldLabel) => ({
  filename, contentType, fieldLabel,
  content: `data:${contentType};base64,${buffer.toString('base64')}`
});

test('the type and extension come from the content, not from the client', async () => {
  const [file] = await processAttachments([att(png, 'scan.pdf', 'application/pdf', 'Photo')], FIELDS);
  assert.equal(file.contentType, 'image/png');
  assert.equal(file.filename, 'scan.png');
});

test('an image does not pass as a document', async () => {
  await assert.rejects(
    processAttachments([att(png, 'scan.pdf', 'application/pdf', 'Document')], FIELDS),
    { code: 'FILE_TYPE_NOT_ALLOWED', fieldLabel: 'Document' }
  );
});

test('an image with a PDF marker is still an image', async () => {
  assert.equal((await detectFileType(pngWithPdfMarker())).mime, 'image/png');
});

test('HTML labelled as text is stored as .txt', async () => {
  const [file] = await processAttachments([att(html, 'notes.html', 'text/plain', 'Document')], FIELDS);
  assert.equal(file.contentType, 'text/plain');
  assert.equal(file.filename, 'notes.txt');
});

test('documents and audio are recognised', async () => {
  const files = await processAttachments([
    att(pdf, 'contract', 'application/octet-stream', 'Document'),
    att(mp3, 'memo.wav', 'audio/wav', 'Recording')
  ], FIELDS);
  assert.deepEqual(files.map(f => [f.filename, f.contentType]), [['contract.pdf', 'application/pdf'], ['memo.mp3', 'audio/mpeg']]);
  assert.equal((await detectFileType(docx)).ext, '.docx');
});

test('unknown content, a plain zip and an unknown field are refused', async () => {
  assert.equal(await detectFileType(binary), null);
  assert.equal(await detectFileType(zip), null);
  await assert.rejects(processAttachments([att(binary, 'run.txt', 'text/plain', 'Document')], FIELDS), { code: 'FILE_TYPE_NOT_ALLOWED' });
  await assert.rejects(processAttachments([att(pdf, 'a.pdf', 'application/pdf', 'Not a field')], FIELDS), { code: 'FILE_TYPE_NOT_ALLOWED' });
  await assert.rejects(processAttachments([att(html, 'a.txt', 'text/plain', 'Recording')], FIELDS), { code: 'FILE_TYPE_NOT_ALLOWED' });
});

test('a file field without subtype accepts images, like the player', async () => {
  const [file] = await processAttachments([att(png, 'me.jpg', 'image/jpeg', 'Old field')], FIELDS);
  assert.equal(file.filename, 'me.png');
  await assert.rejects(processAttachments([att(pdf, 'a.pdf', 'application/pdf', 'Old field')], FIELDS));
});
