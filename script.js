// script.js
import http from 'k6/http';
import { sleep } from 'k6';
export default function () {
  const payload = {
    rollNumber: `CS${Math.floor(Math.random() * 1000)}`,
    qrToken: 'test-token',
    fingerprint: `test-fingerprint-${Math.random()}`
  };
  http.post('https://gvptattendence.onrender.com/scan/code', JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' }
  });
  sleep(0.3); // ~3.33 requests/second
}