// script.js
import http from 'k6/http';
import { sleep } from 'k6';
export default function () {
  const rollNumber = `CS${Math.floor(Math.random() * 1000)}`;
  const qrToken = 'sample-qr-token'; // Replace with valid token
  const fingerprint = `fp${Math.random().toString(36).substring(2)}`;
  const staggerDelay = Math.random() * 10; // Simulate 0–10s stagger
  sleep(staggerDelay);
  http.post('http://your-render-url/scan/code', JSON.stringify({
    rollNumber, qrToken, fingerprint
  }), { headers: { 'Content-Type': 'application/json' } });
}