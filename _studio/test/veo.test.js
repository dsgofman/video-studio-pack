const assert = require('assert');
const V = require('../lib/veo.js');
let p = 0, f = 0;
function t(n, fn) { try { fn(); p++; console.log('  ok   ' + n); } catch (e) { f++; console.log('  FAIL ' + n + ' :: ' + e.message); } }

t('submitUrl + pollUrl', () => {
  assert.ok(V.submitUrl().endsWith(':predictLongRunning'));
  assert.ok(V.submitUrl('veo-x').includes('/models/veo-x:'));
  assert.strictEqual(V.pollUrl('models/veo/operations/abc'), V.HOST + '/models/veo/operations/abc');
  assert.strictEqual(V.pollUrl('https://x/op/1'), 'https://x/op/1');
});

t('requestBody is image→video with 16:9 + duration', () => {
  const b = V.requestBody('a fire flickers', 'QkFTRTY0', 'image/png', { durationSeconds: 6 });
  assert.strictEqual(b.instances[0].prompt, 'a fire flickers');
  assert.strictEqual(b.instances[0].image.bytesBase64Encoded, 'QkFTRTY0');
  assert.strictEqual(b.instances[0].image.mimeType, 'image/png');
  assert.strictEqual(b.parameters.aspectRatio, '16:9');
  assert.strictEqual(b.parameters.durationSeconds, 6);
});

t('requestBody without an image = text→video', () => {
  assert.strictEqual(V.requestBody('x').instances[0].image, undefined);
});

t('operationName + isDone + opError', () => {
  assert.strictEqual(V.operationName({ name: 'models/veo/operations/1' }), 'models/veo/operations/1');
  assert.strictEqual(V.operationName({}), null);
  assert.strictEqual(V.isDone({ done: true }), true);
  assert.strictEqual(V.isDone({}), false);
  assert.strictEqual(V.opError({ error: { message: 'quota' } }), 'quota');
  assert.strictEqual(V.opError({ done: true }), null);
});

t('videoResult finds a uri in the generateVideoResponse shape', () => {
  const op = { done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri: 'https://v/1.mp4' } }] } } };
  assert.deepStrictEqual(V.videoResult(op), { uri: 'https://v/1.mp4' });
});

t('videoResult finds inline bytes + the videos[] + predictions[] shapes', () => {
  assert.deepStrictEqual(V.videoResult({ response: { videos: [{ bytesBase64Encoded: 'QQ==' }] } }), { bytes: 'QQ==' });
  assert.deepStrictEqual(V.videoResult({ response: { predictions: [{ video: { uri: 'u' } }] } }), { uri: 'u' });
  assert.strictEqual(V.videoResult({ done: true, response: {} }), null);
});

console.log('\n' + p + ' passed, ' + f + ' failed');
process.exit(f ? 1 : 0);
