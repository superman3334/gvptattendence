async function getFingerprint() {
  try {
    const response = await fetch('https://cdn.jsdelivr.net/npm/@fingerprintjs/fingerprintjs@3/dist/fp.min.js');
    const FingerprintJS = await response.text();
    eval(FingerprintJS);
    const fp = await FingerprintJS.load();
    const result = await fp.get();
    return result.visitorId;
  } catch (err) {
    console.error('Fingerprint error:', err);
    return 'unknown';
  }
}