// Metadados de um vídeo via watch page (§12.1).
import { FETCH_TIMEOUT_MS } from '../shared/constants.js';
import { extractJsonAssignment } from './youtube-html.js';

/** @typedef {{videoId:string, title:string, author:string, channelId:string|null, lengthSec:number, isLive:boolean, category:string|null}} VideoMeta */

/** ytInitialPlayerResponse -> VideoMeta (PURO). */
export function metaFromPlayerResponse(pr, videoId) {
  const vd = pr?.videoDetails;
  if (!vd) return null;
  return {
    videoId: vd.videoId || videoId,
    title: vd.title || '',
    author: vd.author || '',
    channelId: vd.channelId || null,
    lengthSec: Number(vd.lengthSeconds) || 0,
    isLive: !!vd.isLiveContent && vd.isLive !== false,
    category: pr.microformat?.playerMicroformatRenderer?.category ?? null,
  };
}

/** @returns {Promise<VideoMeta>} */
export async function getVideoMeta(videoId) {
  const res = await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}&hl=en`, {
    credentials: 'include',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    headers: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  if (!res.ok) throw new Error(`watch HTTP ${res.status}`);
  const html = await res.text();
  const meta = metaFromPlayerResponse(extractJsonAssignment(html, 'ytInitialPlayerResponse'), videoId);
  if (!meta) throw new Error('ytInitialPlayerResponse ausente');
  return meta;
}
