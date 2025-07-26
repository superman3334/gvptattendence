import http from 'k6/http';
import { check, sleep } from 'k6';
import { SharedArray } from 'k6/data';

// Pre-generated student roll numbers to avoid duplicates
const students = new SharedArray('students', function () {
  return Array.from({ length: 200 }, (_, i) => ({
    rollNumber: `CS${i + 1}_0`, // CS1_0, CS2_0, ..., CS200_0
    fingerprint: `fingerprint-${i + 1}-${Date.now()}`, // Unique fingerprint
  }));
});

// Configuration
export const options = {
  vus: 200, // 200 virtual users
  duration: '90s', // Run for 90 seconds
  iterations: 200, // Total 200 requests
  thresholds: {
    http_req_failed: ['rate<0.01'], // <1% failure rate
    http_req_duration: ['p(95)<1000'], // 95% of requests <1s
  },
};

// Global variables
let slotId = 'YOUR_SLOT_ID'; // Replace with actual slotId
const baseUrl = 'https://your-render-app.onrender.com'; // Replace with your Render URL
let currentQrToken = null;
let lastQrTokenFetch = 0;

// Fetch QR token every 15 seconds
function fetchQrToken() {
  const now = Date.now();
  if (now - lastQrTokenFetch < 15000 && currentQrToken) {
    return currentQrToken; // Use cached token if within 15s
  }
  const res = http.get(`${baseUrl}/faculty/slots?facultyId=YOUR_FACULTY_ID&slotId=${slotId}`);
  check(res, { 'QR token fetch status is 200': (r) => r.status === 200 });
  const slot = res.json();
  if (slot.error || !slot) {
    console.error('Failed to fetch QR token:', slot.error || 'No slot data');
    return null;
  }
  currentQrToken = slot.qrToken; // Assume slot document includes qrToken
  lastQrTokenFetch = now;
  return currentQrToken;
}

export default function () {
  const student = students[__VU - 1]; // Assign unique student to each VU
  const qrToken = fetchQrToken();
  if (!qrToken) {
    console.error('No valid QR token for VU', __VU);
    return;
  }

  const payload = {
    rollNumber: student.rollNumber,
    qrToken: qrToken,
    fingerprint: student.fingerprint,
  };

  const res = http.post(`${baseUrl}/scan/code`, JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  });

  check(res, {
    'status is 200': (r) => r.status === 200,
    'no error': (r) => !r.json().error,
    'attendance marked': (r) => r.json().message === 'Successfully marked present',
  });

  // Spread load over 90s (~2.22 requests/s)
  sleep(0.45); // ~450ms delay per VU (200 * 0.45s = 90s total)
}