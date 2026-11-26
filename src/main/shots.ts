import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';
import { SHOT_SCHEME, shotPath } from '../shared/shots';

/**
 * Screenshots a Worker reported, for the result card's thumbnails (T-0102): image files on this computer's own disks by
 * absolute path, nothing else (no network paths). Never cached, so a shot taken again under the same name shows anew.
 */
export function serveShots() {
  protocol.handle(SHOT_SCHEME, async (req) => {
    const p = shotPath(req.url);
    if (!p || !path.isAbsolute(p)) return new Response(null, { status: 404 });
    try {
      const r = await net.fetch(pathToFileURL(p).toString());
      return new Response(r.body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') ?? 'application/octet-stream', 'cache-control': 'no-store' } });
    } catch { return new Response(null, { status: 404 }); }
  });
}
