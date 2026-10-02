// Unit test for buildContent: how the window's text + attachments become a Claude message.
// No session is started. Run: node scripts/content-test.mjs
import assert from 'node:assert/strict';
import { buildContent, MAX_IMAGE_BYTES } from '../src/session.mjs';

const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64');

// text only -> plain string
assert.equal(buildContent('  hello  '), 'hello');

// file attachments -> named by path in the text
assert.equal(
  buildContent('look', [{ kind: 'file', name: 'a.cs', path: 'C:\\x\\a.cs' }]),
  'look\n\nAttached file:\n- C:\\x\\a.cs',
);
assert.equal(
  buildContent('', [{ kind: 'file', path: 'C:\\a' }, { kind: 'file', path: 'C:\\b' }]),
  'Attached files:\n- C:\\a\n- C:\\b',
);

// image -> text block + image block
const withImg = buildContent('what is this', [{ kind: 'image', name: 'p.png', mediaType: 'image/png', data: png }]);
assert.ok(Array.isArray(withImg));
assert.deepEqual(withImg[0], { type: 'text', text: 'what is this' });
assert.deepEqual(withImg[1], { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png } });

// image only -> no empty text block
const onlyImg = buildContent('', [{ kind: 'image', name: 'p.png', mediaType: 'image/png', data: png }]);
assert.equal(onlyImg.length, 1);
assert.equal(onlyImg[0].type, 'image');

// rejects: wrong type, oversize, non-base64
assert.throws(() => buildContent('x', [{ kind: 'image', name: 'a.svg', mediaType: 'image/svg+xml', data: png }]), /PNG, JPEG, GIF or WebP/);
assert.throws(() => buildContent('x', [{ kind: 'image', name: 'big.png', mediaType: 'image/png', data: 'A'.repeat(Math.ceil(MAX_IMAGE_BYTES / 0.75) + 8) }]), /larger than/);
assert.throws(() => buildContent('x', [{ kind: 'image', name: 'bad.png', mediaType: 'image/png', data: '<script>' }]), /could not be read/);

// at most 10 attachments are used
const many = Array.from({ length: 14 }, (_, i) => ({ kind: 'file', path: `C:\\f${i}` }));
assert.equal(buildContent('', many).split('\n').length - 1, 10);

console.log('content-test: all passed');
