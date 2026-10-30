// Some feeds (Sydney Trains, ferries, regional trains) mostly send a delay at
// one or two stops and leave the rest to the timetable. This fills in every
// remaining stop with its scheduled time plus the latest known delay.
import { addDays, serviceDayStart, sydneyDate } from './time.js';

const SLACK_S = 3 * 3600;

function serviceBase(trip, start, length, now) {
  if (trip.startDate) return serviceDayStart(trip.startDate) + start;
  if (todayFor[0] !== now) todayFor = [now, sydneyDate(now)];
  const today = todayFor[1];
  for (const d of [today, addDays(today, -1), addDays(today, 1)]) {
    const base = serviceDayStart(d) + start;
    if (now >= base - SLACK_S && now <= base + length + SLACK_S) return base;
  }
  return serviceDayStart(today) + start;
}

let todayFor = [0, ''];

export function applyTimetable(trip, timetable, now) {
  const entry = timetable?.trips[trip.tripId];
  if (!entry) return trip;
  const [headsign, stops, offsets] = timetable.patterns[entry[0]];
  const base = serviceBase(trip, entry[1], offsets[offsets.length - 1], now);

  const calls = [];
  let j = 0;
  let delay = null;
  for (let i = 0; i < stops.length; i++) {
    const sched = base + offsets[i];
    const u = trip.calls[j];
    if (u && u.stopId === stops[i]) {
      j++;
      if (u.t) delay = u.t - sched;
      else if (u.delay != null) delay = u.delay;
      calls.push({ stopId: stops[i], t: u.t || sched + (delay ?? 0), delay, skip: u.skip });
    } else {
      calls.push({ stopId: stops[i], t: sched + (delay ?? 0), delay, skip: false });
    }
  }
  // Updates that don't follow the timetable's stops mean a changed stopping
  // pattern; trust the realtime feed alone then.
  if (j < trip.calls.length) return { ...trip, headsign };
  return { ...trip, headsign, calls };
}
