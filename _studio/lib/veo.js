// Google Veo (image→video) via the Gemini API — pure request/response helpers (testable). The async flow
// (submit → poll the long-running operation → download) lives in server.js. Veo's response shape has
// shifted across versions, so the result parser checks several documented paths defensively. Runs on the
// SAME generativelanguage host + Gemini key we already use; needs the key to have Veo access.
'use strict';

const HOST = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'veo-3.0-generate-preview';

function submitUrl(model) { return `${HOST}/models/${model || DEFAULT_MODEL}:predictLongRunning`; }
// op name can be "models/.../operations/x", "operations/x", or already a full URL.
function pollUrl(opName) { return /^https?:/.test(opName) ? opName : `${HOST}/${String(opName).replace(/^\//, '')}`; }

// image→video request. Omitting the image yields text→video; we always seed from the beat's still so it
// stays on-model.
function requestBody(prompt, imageB64, mimeType, opts = {}) {
  const instance = { prompt: String(prompt || '').slice(0, 1000) };
  if (imageB64) instance.image = { bytesBase64Encoded: imageB64, mimeType: mimeType || 'image/png' };
  return {
    instances: [instance],
    parameters: {
      aspectRatio: opts.aspectRatio || '16:9',
      durationSeconds: opts.durationSeconds || 6,
      personGeneration: opts.personGeneration || 'allow_adult',
      sampleCount: 1,
    },
  };
}

function operationName(submitJson) { return (submitJson && (submitJson.name || submitJson.operationName)) || null; }
function isDone(opJson) { return !!(opJson && opJson.done); }
function opError(opJson) { return (opJson && opJson.error) ? (opJson.error.message || JSON.stringify(opJson.error)) : null; }

// Find the produced video as { uri } or { bytes } across the shapes Veo has used. Returns null if none.
function videoResult(opJson) {
  const resp = (opJson && (opJson.response || opJson.result)) || {};
  const gvr = resp.generateVideoResponse || {};
  const buckets = [gvr.generatedSamples, resp.generatedSamples, gvr.videos, resp.videos].filter(Array.isArray);
  for (const arr of buckets) {
    for (const s of arr) {
      const v = (s && s.video) || s || {};
      if (v.uri || v.videoUri) return { uri: v.uri || v.videoUri };
      if (v.bytesBase64Encoded || v.data) return { bytes: v.bytesBase64Encoded || v.data };
    }
  }
  for (const p of (resp.predictions || [])) {
    const v = p.video || p;
    if (v && (v.uri || v.bytesBase64Encoded)) return v.uri ? { uri: v.uri } : { bytes: v.bytesBase64Encoded };
  }
  return null;
}

module.exports = { HOST, DEFAULT_MODEL, submitUrl, pollUrl, requestBody, operationName, isDone, opError, videoResult };
