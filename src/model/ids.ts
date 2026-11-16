const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function randomId(len: number): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += ALPHABET[b % 36];
  return s;
}

let counter = 0;

/** Stroke ids are unique across devices: device prefix + time + counter + random. */
export function newStrokeId(deviceId: string): string {
  counter = (counter + 1) % 1296;
  return `${deviceId.slice(0, 4)}${Date.now().toString(36)}${counter.toString(36).padStart(2, '0')}${randomId(3)}`;
}
