// A small iCalendar (RFC 5545) reader: parses VEVENTs and expands recurring ones into the
// occurrences that fall in a time window. Covers what calendar exports use in practice:
// time zones (IANA TZIDs), RRULE with DAILY / WEEKLY / MONTHLY / YEARLY, INTERVAL, COUNT, UNTIL,
// BYDAY (with ordinals), BYMONTHDAY, BYMONTH and WKST, plus EXDATE, RDATE and moved or
// cancelled instances (RECURRENCE-ID).

const DAY_MS = 86_400_000;
const SLACK_MS = 15 * 3_600_000; // more than any UTC offset, for cheap range checks before exact conversion

// --------------------------------------------------------------------------- parsing

const unfold = (text) => text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "");

const unescapeText = (s) => s.replace(/\\([\\;,nN])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));

// "NAME;P1=a;P2=\"b:c\":value" -> { name, params, value }
function parseLine(line) {
  let i = 0, quoted = false;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') quoted = !quoted;
    else if (c === ":" && !quoted) break;
  }
  const head = line.slice(0, i);
  const value = line.slice(i + 1);
  const parts = head.match(/(?:[^;"]|"[^"]*")+/g) || [head];
  const params = {};
  for (const p of parts.slice(1)) {
    const eq = p.indexOf("=");
    if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
  }
  return { name: parts[0].toUpperCase(), params, value };
}

// "20261103T140000Z" / "20261103T140000" (+TZID) / "20261103" -> a wall-clock time and its zone.
function parseTime(value, params, defaultTz) {
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return null;
  const allDay = !m[4];
  return {
    y: +m[1], mo: +m[2], d: +m[3], h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0),
    tz: m[7] ? "UTC" : params.TZID || defaultTz || null, // null = the machine's local time
    allDay,
  };
}

function parseRule(value) {
  const r = {};
  for (const part of value.split(";")) {
    const [k, v] = part.split("=");
    if (k && v !== undefined) r[k.toUpperCase()] = v;
  }
  return {
    freq: r.FREQ,
    interval: Math.max(1, +r.INTERVAL || 1),
    count: r.COUNT ? +r.COUNT : null,
    until: r.UNTIL ? parseTime(r.UNTIL, {}, null) : null,
    byday: r.BYDAY ? r.BYDAY.split(",").map((s) => { const m = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(s); return m && { n: +(m[1] || 0), wd: WEEKDAYS[m[2]] }; }).filter(Boolean) : null,
    bymonthday: r.BYMONTHDAY ? r.BYMONTHDAY.split(",").map(Number) : null,
    bymonth: r.BYMONTH ? r.BYMONTH.split(",").map(Number) : null,
    wkst: WEEKDAYS[r.WKST] ?? 1,
  };
}

const WEEKDAYS = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

// Reads the VEVENTs (ignoring nested VALARMs and the VTIMEZONE blocks, since IANA zone names
// are resolved by the runtime). Returns { name, tz, events }.
function parse(text) {
  const lines = unfold(text).split("\n");
  const cal = { name: null, tz: null, events: [] };
  let ev = null, depth = 0;
  for (const line of lines) {
    if (!line) continue;
    const { name, params, value } = parseLine(line);
    if (name === "BEGIN") {
      if (value === "VEVENT" && !ev) { ev = { exdates: [], rdates: [], attendees: [] }; depth = 0; }
      else if (ev) depth++;
      continue;
    }
    if (name === "END") {
      if (ev && depth) depth--;
      else if (ev && value === "VEVENT") { cal.events.push(ev); ev = null; }
      continue;
    }
    if (!ev) {
      if (name === "X-WR-CALNAME") cal.name = unescapeText(value);
      if (name === "X-WR-TIMEZONE") cal.tz = value.trim();
      continue;
    }
    if (depth) continue; // inside a VALARM
    switch (name) {
      case "UID": ev.uid = value; break;
      case "SUMMARY": ev.title = unescapeText(value); break;
      case "LOCATION": ev.location = unescapeText(value); break;
      case "DESCRIPTION": ev.description = unescapeText(value); break;
      case "STATUS": ev.status = value.trim().toUpperCase(); break;
      case "DTSTART": ev.start = parseTime(value, params, cal.tz); break;
      case "DTEND": ev.end = parseTime(value, params, cal.tz); break;
      case "DURATION": ev.duration = parseDuration(value); break;
      case "RRULE": ev.rule = parseRule(value); break;
      case "RECURRENCE-ID": ev.recurrenceId = parseTime(value, params, cal.tz); break;
      case "EXDATE": for (const v of value.split(",")) { const t = parseTime(v, params, cal.tz); if (t) ev.exdates.push(t); } break;
      case "RDATE": for (const v of value.split(",")) { const t = parseTime(v, params, cal.tz); if (t) ev.rdates.push(t); } break;
      case "ATTENDEE": ev.attendees.push({ email: value.replace(/^mailto:/i, "").toLowerCase(), partstat: (params.PARTSTAT || "").toUpperCase() }); break;
      case "X-GOOGLE-CONFERENCE": ev.conference = value.trim(); break;
    }
  }
  return cal;
}

function parseDuration(value) {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return null;
  const ms = ((+m[2] || 0) * 7 * DAY_MS) + ((+m[3] || 0) * DAY_MS) + ((+m[4] || 0) * 3_600_000) + ((+m[5] || 0) * 60_000) + ((+m[6] || 0) * 1000);
  return m[1] === "-" ? -ms : ms;
}

// --------------------------------------------------------------------------- time zones

const formatters = new Map();

function formatter(tz) {
  if (!formatters.has(tz)) {
    let f = null;
    try {
      f = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" });
    } catch {} // not an IANA name; treated as local time
    formatters.set(tz, f);
  }
  return formatters.get(tz);
}

// The zone's UTC offset at an instant, in ms.
function offsetAt(ms, f) {
  const p = {};
  for (const x of f.formatToParts(ms)) p[x.type] = x.value;
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
}

// A wall-clock time in a zone -> epoch ms. Times skipped by a DST jump move forward, like calendar apps do.
function toUtc(t) {
  if (t.tz === "UTC") return Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s);
  const f = t.tz && formatter(t.tz);
  if (!f) return new Date(t.y, t.mo - 1, t.d, t.h, t.mi, t.s).getTime();
  const wall = Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s);
  const first = offsetAt(wall, f);
  const second = offsetAt(wall - first, f);
  return wall - (first === second ? first : Math.max(first, second));
}

// --------------------------------------------------------------------------- recurrence

const dayNumber = (y, mo, d) => Date.UTC(y, mo - 1, d) / DAY_MS;
const weekday = (day) => (((day + 4) % 7) + 7) % 7; // 1970-01-01 was a Thursday
const fromDayNumber = (day) => { const dt = new Date(day * DAY_MS); return { y: dt.getUTCFullYear(), mo: dt.getUTCMonth() + 1, d: dt.getUTCDate() }; };
const daysInMonth = (y, mo) => new Date(Date.UTC(y, mo, 0)).getUTCDate();

// Days of one month picked by BYDAY / BYMONTHDAY, or the start's day of month.
function monthDays(y, mo, rule, startDom) {
  const first = dayNumber(y, mo, 1), len = daysInMonth(y, mo);
  const out = [];
  if (rule.byday) {
    for (const { n, wd } of rule.byday) {
      const firstOf = first + ((wd - weekday(first) + 7) % 7);
      const all = [];
      for (let d = firstOf; d < first + len; d += 7) all.push(d);
      if (n === 0) out.push(...all);
      else if (n > 0 && all[n - 1] !== undefined) out.push(all[n - 1]);
      else if (n < 0 && all[all.length + n] !== undefined) out.push(all[all.length + n]);
    }
    if (rule.bymonthday) {
      const keep = new Set(rule.bymonthday.map((md) => (md > 0 ? first + md - 1 : first + len + md)));
      return [...new Set(out)].filter((d) => keep.has(d)).sort((a, b) => a - b);
    }
  } else if (rule.bymonthday) {
    for (const md of rule.bymonthday) {
      const d = md > 0 ? md : len + md + 1;
      if (d >= 1 && d <= len) out.push(first + d - 1);
    }
  } else if (startDom <= len) {
    out.push(first + startDom - 1);
  }
  return [...new Set(out)].sort((a, b) => a - b);
}

// Candidate days in order, one period at a time, starting at the period containing `startDay`.
function* candidateDays(rule, start, startDay) {
  const MAX_PERIODS = 50_000;
  if (rule.freq === "DAILY") {
    for (let i = 0, day = startDay; i < MAX_PERIODS; i++, day += rule.interval) {
      const { mo, d } = fromDayNumber(day);
      if (rule.bymonth && !rule.bymonth.includes(mo)) continue;
      if (rule.bymonthday && !rule.bymonthday.includes(d)) continue;
      if (rule.byday && !rule.byday.some((b) => b.wd === weekday(day))) continue;
      yield day;
    }
  } else if (rule.freq === "WEEKLY") {
    const weekStart = startDay - ((weekday(startDay) - rule.wkst + 7) % 7);
    const offsets = [...new Set((rule.byday || [{ wd: weekday(startDay) }]).map((b) => (b.wd - rule.wkst + 7) % 7))].sort((a, b) => a - b);
    for (let i = 0, w = weekStart; i < MAX_PERIODS; i++, w += 7 * rule.interval) {
      for (const off of offsets) {
        const day = w + off;
        if (rule.bymonth && !rule.bymonth.includes(fromDayNumber(day).mo)) continue;
        yield day;
      }
    }
  } else if (rule.freq === "MONTHLY") {
    for (let i = 0, m = start.y * 12 + start.mo - 1; i < MAX_PERIODS; i++, m += rule.interval) {
      const y = Math.floor(m / 12), mo = (m % 12) + 1;
      if (rule.bymonth && !rule.bymonth.includes(mo)) continue;
      yield* monthDays(y, mo, rule, start.d);
    }
  } else if (rule.freq === "YEARLY") {
    for (let i = 0, y = start.y; i < MAX_PERIODS; i++, y += rule.interval) {
      for (const mo of rule.bymonth || [start.mo]) yield* monthDays(y, mo, rule, start.d);
    }
  }
}

// Start times (epoch ms) of a recurring event that begin in [from, to).
function expand(ev, from, to) {
  const rule = ev.rule, s = ev.start;
  const startDay = dayNumber(s.y, s.mo, s.d);
  const tod = ((s.h * 60 + s.mi) * 60 + s.s) * 1000;
  const until = rule.until && (rule.until.allDay ? toUtc({ ...rule.until, h: 23, mi: 59, s: 59, tz: s.tz }) : toUtc(rule.until));
  const out = [];
  let count = 0;
  for (const day of candidateDays(rule, s, startDay)) {
    if (day < startDay) continue;
    const rough = day * DAY_MS + tod; // the wall time read as UTC; the real instant is within SLACK_MS
    if (rough - SLACK_MS >= to || (until !== null && rough - SLACK_MS > until)) break;
    count++;
    if (rule.count !== null && count > rule.count) break;
    if (rough + SLACK_MS < from) continue;
    const at = toUtc({ ...fromDayNumber(day), h: s.h, mi: s.mi, s: s.s, tz: s.tz });
    if (until !== null && at > until) break;
    if (at >= from && at < to) out.push(at);
  }
  return out;
}

// --------------------------------------------------------------------------- occurrences

const MEETING_LINK = /https:\/\/[^\s"<>]*(zoom\.us\/(?:j|my|w)\/|meet\.google\.com\/|teams\.microsoft\.com\/l\/meetup-join|teams\.live\.com\/meet|webex\.com\/(?:meet|join)|whereby\.com\/|meet\.jit\.si\/)[^\s"<>]*/i;

function meetingLink(ev) {
  if (ev.conference) return ev.conference;
  for (const text of [ev.location, ev.description]) {
    const m = text && MEETING_LINK.exec(text);
    if (m) return m[0].replace(/[).,;]+$/, "");
  }
  return null;
}

// Timed events overlapping [from, to), as { uid, title, start, end, link, response }, sorted by start.
// All-day and cancelled events are skipped, and so are invites `owner` (an email address) declined.
function occurrences(cal, from, to, owner) {
  const me = (owner || cal.name || "").toLowerCase();
  const response = (ev) => ev.attendees.find((a) => a.email === me)?.partstat || null;
  const durationOf = (ev) => {
    const start = toUtc(ev.start);
    if (ev.end) return toUtc(ev.end) - start;
    return ev.duration ?? 0;
  };

  const moved = new Map(); // uid -> Set of original start ms that have their own VEVENT
  for (const ev of cal.events) {
    if (ev.recurrenceId && ev.uid) {
      if (!moved.has(ev.uid)) moved.set(ev.uid, new Set());
      moved.get(ev.uid).add(toUtc(ev.recurrenceId));
    }
  }

  const out = [];
  const add = (ev, start, duration) => {
    const end = start + duration;
    if (end <= from || start >= to) return;
    out.push({ uid: ev.uid, title: ev.title || "(no title)", start, end, link: meetingLink(ev), response: response(ev) });
  };

  for (const ev of cal.events) {
    if (!ev.start || ev.start.allDay || ev.status === "CANCELLED") continue;
    if (response(ev) === "DECLINED") continue;
    const duration = durationOf(ev);
    if (ev.recurrenceId || !ev.rule) {
      add(ev, toUtc(ev.start), duration);
      continue;
    }
    const skip = new Set([...ev.exdates.map(toUtc), ...(moved.get(ev.uid) || [])]);
    const starts = new Set(expand(ev, from - duration, to));
    for (const r of ev.rdates) if (!r.allDay) starts.add(toUtc(r));
    for (const start of starts) if (!skip.has(start)) add(ev, start, duration);
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

module.exports = { parse, occurrences, toUtc, expand };
