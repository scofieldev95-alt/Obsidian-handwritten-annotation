import type { Stroke } from '../ink/types.ts';
import type { DeviceInk } from '../model/document.ts';

const HEX = /^#[0-9a-f]{6}$/i;
const ID = /^[0-9a-z]{4,40}$/;

/** A stroke read from disk, or null if it is malformed (one bad stroke never breaks a file). */
export function validStroke(raw: unknown): Stroke | null {
  if (!raw || typeof raw !== 'object') return null;
  const s = raw as Record<string, unknown>;
  if (typeof s.id !== 'string' || !ID.test(s.id)) return null;
  if (s.tool !== 'pen' && s.tool !== 'highlighter') return null;
  if (typeof s.color !== 'string' || !HEX.test(s.color)) return null;
  if (typeof s.width !== 'number' || !(s.width > 0 && s.width < 200)) return null;
  if (!Array.isArray(s.pts) || s.pts.length < 3 || s.pts.length % 3 !== 0) return null;
  if (!s.pts.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  return {
    id: s.id,
    tool: s.tool,
    color: s.color,
    width: s.width,
    pressure: s.pressure === true,
    pts: s.pts as number[],
    at: typeof s.at === 'number' && Number.isFinite(s.at) ? s.at : 0,
  };
}

/** A device's ink file read from disk. Unknown fields are ignored; bad strokes are dropped. */
export function validDeviceInk(raw: unknown): DeviceInk {
  const out: DeviceInk = { pages: {}, deleted: [] };
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (r.pages && typeof r.pages === 'object') {
    for (const [key, list] of Object.entries(r.pages as Record<string, unknown>)) {
      const page = Number(key);
      if (!Number.isInteger(page) || page < 1 || page > 100_000 || !Array.isArray(list)) continue;
      const strokes = list.map(validStroke).filter((s): s is Stroke => s !== null);
      if (strokes.length) out.pages[String(page)] = strokes;
    }
  }
  if (Array.isArray(r.deleted)) out.deleted = r.deleted.filter((id): id is string => typeof id === 'string' && ID.test(id));
  const v = r.view as Record<string, unknown> | undefined;
  if (v && Number.isInteger(v.page) && (v.page as number) >= 1 && typeof v.at === 'number') {
    out.view = { page: v.page as number, at: v.at };
  }
  return out;
}
