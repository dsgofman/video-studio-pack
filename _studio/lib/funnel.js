// Pure helper: rewrite a Short's description so it has exactly one correct "Full video → <url>" funnel line,
// just above the #Shorts hashtag line, preserving the caption body. Idempotent. Used by the funnel sync.
function rebuildShortDescription(currentDesc, longUrl) {
  const lines = String(currentDesc || '').replace(/\r/g, '').split('\n');
  const kept = [];
  let shortsTag = '';
  for (const ln of lines) {
    const t = ln.trim();
    if (/^Full video\s*→/i.test(t)) continue;                                   // drop old funnel line
    if (/^https?:\/\/(youtu\.be|www\.youtube\.com)\/\S+$/i.test(t)) continue;    // drop stray bare url line
    if (/^#\w[\w\s#]*$/.test(t) && /#shorts\b/i.test(t)) { shortsTag = t; continue; }  // capture the #Shorts tag line
    kept.push(ln);
  }
  let body = kept.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '');
  let out = body;
  if (longUrl) out += (body ? '\n\n' : '') + 'Full video → ' + longUrl;
  if (shortsTag) out += (out ? '\n\n' : '') + shortsTag;
  return out;
}

module.exports = { rebuildShortDescription };
