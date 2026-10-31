// Decides when the deployment should rebuild itself to pick up a fresh
// timetable. The build records when its timetable copy runs out; a daily cron
// asks here and, when due, calls the project's deploy hook.
import { readFileSync } from 'node:fs';
import { addDays, sydneyDate } from './time.js';

const DAYS_BEFORE_EXPIRY = 7;
const MAX_AGE_DAYS = 21; // also picks up new stops and routes

export function readMeta(path = new URL('../data/meta.json', import.meta.url)) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return { builtAt: '', timetableExpires: '' };
  }
}

export function refreshDue(meta, nowS = Date.now() / 1000) {
  const today = sydneyDate(nowS);
  if (!meta.builtAt) return { due: true, reason: 'no build information' };
  const builtDay = sydneyDate(Date.parse(meta.builtAt) / 1000);
  if (today >= addDays(builtDay, MAX_AGE_DAYS)) return { due: true, reason: `built ${builtDay}, over ${MAX_AGE_DAYS} days ago` };
  if (meta.timetableExpires && today >= addDays(meta.timetableExpires, -DAYS_BEFORE_EXPIRY)) {
    return { due: true, reason: `timetable runs out ${meta.timetableExpires}` };
  }
  return { due: false, reason: `timetable good until ${meta.timetableExpires || 'unknown'}` };
}
