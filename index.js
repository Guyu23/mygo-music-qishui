// Soda Music (汽水音乐) source for MyGo Music.
// Sign-in is the official app QR flow. The session stays in plugin storage.
// Playback uses the stream URL the service returns and does not decrypt protected audio.

const API = "https://api.qishui.com";
const APP_ID = "386088";
const APP_VERSION = "3.7.0";
const CHANNEL = "official";
const PACKAGE = "com.soda.music";
const USER_AGENT = `LunaPC/${APP_VERSION}(${CHANNEL})`;
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const COMPUTER_NAME = "Windows";

const JSSDK = {
  passport_jssdk_version: "4.2.3",
  passport_jssdk_type: "lite",
  is_from_ttaccountsdk: "1",
  account_sdk_source: "web",
};

const QR_STATUS = {
  1: "waiting",
  2: "scanned",
  3: "confirmed",
  4: "expired",
  new: "waiting",
  waiting: "waiting",
  scanned: "scanned",
  scan: "scanned",
  confirm: "confirmed",
  confirmed: "confirmed",
  expired: "expired",
};

let memory = null;
let devicePromise = null;
let discoverCache = null;
let libraryCache = null;
let likedCache = null;
let meCache = null;
const detailCache = new Map();
const stationPlayed = new Map();
const searchIds = new Map();

function t(text) {
  return host.t(text);
}

function problem(code, message) {
  const error = new Error(t(message));
  error.code = code;
  throw error;
}

function load() {
  if (memory) return memory;
  const saved = host.storage.get("session");
  memory = saved && typeof saved === "object" ? { ...saved } : {};
  if (!memory.cookies || typeof memory.cookies !== "object") memory.cookies = {};
  return memory;
}

function save() {
  host.storage.set("session", {
    device: memory.device ?? null,
    cookies: memory.cookies,
  });
}

function loggedIn() {
  const cookies = load().cookies;
  return Boolean(cookies.sessionid || cookies.sid_tt || cookies.passport_assist_user);
}

function requireLogin() {
  if (!loggedIn()) problem("signIn", "Sign in to Soda Music");
}

function cookieHeader() {
  const cookies = load().cookies;
  const parts = Object.entries(cookies).map(([name, value]) => `${name}=${value}`);
  return parts.length ? parts.join("; ") : "";
}

function absorbCookies(response) {
  const list = [];
  if (typeof response.headers.getSetCookie === "function") {
    list.push(...response.headers.getSetCookie());
  } else {
    const single = response.headers.get("set-cookie");
    if (single) list.push(single);
  }
  if (!list.length) return;
  const cookies = load().cookies;
  for (const raw of list) {
    const index = raw.indexOf("=");
    if (index < 0) continue;
    const name = raw.slice(0, index).trim();
    const value = raw.slice(index + 1).split(";")[0].trim();
    if (!name) continue;
    if (!value || /max-age=0/i.test(raw)) delete cookies[name];
    else cookies[name] = value;
  }
  save();
}

function numberStarts(out) {
  for (let i = out.length - 1; i >= 0; i--) {
    const prev = out[i];
    if (prev === " " || prev === "\n" || prev === "\r" || prev === "\t") continue;
    return prev === ":" || prev === "," || prev === "[";
  }
  return true;
}

function parseJson(text) {
  // Track and playlist ids are larger than 2^53. Quote those integers before
  // JSON.parse. Digits inside strings, and the fractional part of a number, stay as they are.
  const out = [];
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      out.push(ch);
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out.push(ch);
      continue;
    }
    if ((ch === "-" || (ch >= "0" && ch <= "9")) && numberStarts(out)) {
      let j = i;
      if (text[j] === "-") j++;
      const digits = j;
      while (j < text.length && text[j] >= "0" && text[j] <= "9") j++;
      const next = text[j];
      if (next !== "." && next !== "e" && next !== "E" && j - digits >= 16) {
        out.push(`"${text.slice(i, j)}"`);
        i = j - 1;
        continue;
      }
    }
    out.push(ch);
  }
  return JSON.parse(out.join(""));
}

function parseLrc(content) {
  const lines = [];
  for (const raw of content.split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!tags.length) continue;
    const text = raw.slice(raw.lastIndexOf("]") + 1).trim();
    if (!text) continue;
    for (const tag of tags) {
      const start = Math.round((Number(tag[1]) * 60 + Number(tag[2])) * 1000);
      lines.push({ start, text });
    }
  }
  lines.sort((a, b) => a.start - b.start);
  return lines.map((line, index) => {
    const end = lines[index + 1]?.start ?? line.start + 1000;
    return { start: line.start, end, text: line.text, words: [{ start: line.start, end, text: line.text }] };
  });
}

function parseLyrics(lyric) {
  const content = lyric?.content;
  if (typeof content !== "string" || !content.trim()) return [];
  if (/\[\d+,\d+\]/.test(content)) {
    const timed = parseKrc(content);
    if (timed.length) return timed;
  }
  return parseLrc(content);
}

function uuid() {
  if (globalThis.crypto?.randomUUID) return crypto.randomUUID();
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const n = (Math.random() * 16) | 0;
    return (char === "x" ? n : (n & 0x3) | 0x8).toString(16);
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function readBody(response) {
  absorbCookies(response);
  if (response.headers.get("bdturing-verify") || response.headers.get("x-tt-verify-passport-decision")) {
    problem("unavailable", "Soda Music asked for a verification challenge. Try again later.");
  }
  const text = await response.text();
  if (!response.ok) {
    throw new Error(t("Could not reach Soda Music"));
  }
  if (!text) throw new Error(t("Could not reach Soda Music"));
  try {
    return parseJson(text);
  } catch {
    throw new Error(t("Could not reach Soda Music"));
  }
}

function statusError(json, what) {
  const code = json?.status_code;
  if (typeof code !== "number" || code === 0) return;
  if (code === 1000016) problem("signIn", "Sign in to Soda Music");
  const message = json?.status_info?.status_msg || json?.status_info || `${what} (${code})`;
  throw new Error(typeof message === "string" ? message : `${what} (${code})`);
}

async function ensureDevice() {
  const session = load();
  if (session.device?.deviceId) return session.device;
  if (!devicePromise) {
    devicePromise = registerDevice().then(
      (device) => {
        devicePromise = null;
        return device;
      },
      (error) => {
        devicePromise = null;
        throw error;
      },
    );
  }
  return devicePromise;
}

async function registerDevice() {
  const session = load();
  const cdid = uuid();
  const payload = {
    header: {
      device_id: "",
      install_id: "",
      os: "Windows",
      device_platform: "PC",
      sdk_version: "1.0",
      sdk_version_code: 1,
      aid: Number(APP_ID),
      mc: "00:00:00:00:00:00",
      channel: CHANNEL,
      package: PACKAGE,
      language: "zh-CN",
      app_version: APP_VERSION,
      os_version: "Windows 10: 10.0",
      device_model: "no detected",
      time_zone: "Asia/Shanghai",
      tz_name: "Asia/Shanghai",
      tz_offset: 0,
      resolution: "no detected",
      app_region: "cn",
      app_language: "zh-CN",
      display_name: "汽水音乐",
      pc_uuid: cdid,
      pc_serial: "",
    },
    gen_time: Date.now(),
    magic_tag: "ss_app_log",
  };
  const query = new URLSearchParams({
    aid: APP_ID,
    channel: CHANNEL,
    os: "Windows",
    os_version: "Windows 10: 10.0",
    device_platform: "PC",
    app_version: APP_VERSION,
  });
  let response;
  try {
    response = await fetch(`${API}/service/2/desktop/device_register/?${query}`, {
      method: "POST",
      headers: { "user-agent": USER_AGENT, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    throw new Error(t("Could not reach Soda Music"));
  }
  const json = await readBody(response);
  if (!json?.device_id_str) throw new Error(t("Could not reach Soda Music"));
  session.device = {
    deviceId: String(json.device_id_str),
    installId: String(json.install_id_str ?? ""),
    cdid,
  };
  save();
  return session.device;
}

function commonQuery(device) {
  return {
    aid: APP_ID,
    app_name: "luna_pc",
    region: "cn",
    geo_region: "cn",
    os_region: "cn",
    sim_region: "",
    device_id: device.deviceId,
    cdid: "",
    iid: device.installId,
    version_name: APP_VERSION,
    version_code: APP_VERSION,
    channel: CHANNEL,
    build_mode: "master",
    network_carrier: "",
    ac: "wifi",
    tz_name: "Asia/Shanghai",
    resolution: "",
    device_platform: "windows",
    device_type: "Windows",
    os_version: "Windows 10 Pro",
    fp: device.deviceId,
  };
}

async function request(method, path, { query = {}, body } = {}) {
  const device = await ensureDevice();
  const url = new URL(path, API);
  const params = { ...commonQuery(device), ...query };
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) continue;
    url.searchParams.set(key, String(value));
  }
  const headers = {
    "user-agent": USER_AGENT,
    accept: "application/json",
    "x-luna-is-local-user": loggedIn() ? "1" : "0",
  };
  const cookie = cookieHeader();
  if (cookie) headers.cookie = cookie;
  let payload;
  if (method !== "GET" && method !== "HEAD") {
    payload = JSON.stringify(body ?? {});
    headers["content-type"] = "application/json; charset=utf-8";
    headers["x-ss-stub"] = host.crypto.md5(payload).toUpperCase();
  }
  let response;
  try {
    response = await fetch(url, { method, headers, body: payload });
  } catch {
    throw new Error(t("Could not reach Soda Music"));
  }
  const json = await readBody(response);
  statusError(json, path);
  return json;
}

function imageOf(img, size = 800) {
  if (!img) return "";
  if (typeof img === "string") return img;
  const base = img.urls?.[0];
  if (img.uri && base) {
    const suffix = img.template_prefix
      ? `${img.template_prefix}-crop-center:${size}:${size}.jpg`
      : `c5_${size}x${size}.jpg`;
    return `${base}${img.uri}~${suffix}`;
  }
  return base || "";
}

function releasedOf(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    return new Date(ms).toISOString().slice(0, 10);
  }
  return "";
}

function toArtist(artist) {
  if (!artist || (artist.id == null && !artist.name)) return null;
  return {
    id: artist.id == null ? "" : String(artist.id),
    name: artist.name || "",
    imageUrl: imageOf(artist.url_avatar || artist.url_pic || artist.url_cover),
  };
}

function toAlbum(album) {
  if (!album || (album.id == null && !album.name && !album.title)) return null;
  return {
    id: album.id == null ? "" : String(album.id),
    name: album.name || album.title || "",
    imageUrl: imageOf(album.url_cover),
    artists: (album.artists || []).map(toArtist).filter(Boolean),
    released: releasedOf(album.release_date),
  };
}

function toTrack(track) {
  if (!track) return null;
  const id = track.id ?? track.track_id;
  const name = track.name || track.title;
  if (id == null && !name) return null;
  const album = track.album || {};
  return {
    id: id == null ? "" : String(id),
    name: name || "Unknown",
    artists: (track.artists || []).map(toArtist).filter(Boolean),
    album: {
      id: album.id == null ? "" : String(album.id),
      name: album.name || "",
      imageUrl: imageOf(album.url_cover),
    },
    duration: Number(track.duration ?? track.duration_ms) || 0,
  };
}

function toPlaylist(playlist, { mine = false } = {}) {
  if (!playlist?.id && !playlist?.title && !playlist?.name) return null;
  const type = Number(playlist.type);
  const fixed = mine && (type === 1 || type === 4);
  return {
    id: String(playlist.id ?? ""),
    name: playlist.title || playlist.name || "Playlist",
    imageUrl: imageOf(playlist.url_cover),
    description: playlist.desc || playlist.description || "",
    owner: playlist.owner?.nickname || playlist.owner?.name || "",
    trackCount: Number(playlist.count_tracks) || 0,
    mine,
    fixed,
  };
}

function tracksFrom(list) {
  return (list || [])
    .map((item) =>
      toTrack(
        item?.entity?.track_wrapper?.track ||
          item?.entity?.ranked_track?.track ||
          item?.entity?.track ||
          item?.track ||
          item,
      ),
    )
    .filter(Boolean);
}

function discoverParts(json) {
  const playlists = [];
  const charts = [];
  for (const block of json?.blocks || []) {
    for (const inner of block.inner_block || []) {
      if (inner.type === "discover_playlist") {
        const playlist = toPlaylist(inner.resources?.[0]?.entity?.playlist, { mine: false });
        if (playlist) playlists.push(playlist);
      }
      if (inner.type === "discover_track_top_list" || inner.type === "discover_top_song_list") {
        charts.push({
          id: inner.inner_block_id == null ? "" : String(inner.inner_block_id),
          title: inner.title || block.title || t("Charts"),
          description: inner.desc || inner.description || "",
          tracks: tracksFrom(inner.resources),
        });
      }
    }
  }
  return { playlists, charts };
}

async function discover() {
  if (discoverCache && Date.now() - discoverCache.at < 60_000) return discoverCache.json;
  const json = await request("POST", "/luna/pc/discover", { body: {} });
  discoverCache = { at: Date.now(), json };
  return json;
}

async function myPlaylists() {
  requireLogin();
  if (libraryCache) return libraryCache;
  const json = await request("GET", "/luna/pc/me/playlist", { query: { cursor: "0", count: "100" } });
  libraryCache = json.playlists || [];
  return libraryCache;
}

function invalidateLibrary() {
  libraryCache = null;
  likedCache = null;
}

async function favoritePlaylist() {
  const playlists = await myPlaylists();
  return playlists.find((playlist) => Number(playlist.type) === 1) || null;
}

async function songFeed({ preference = "default", sceneId, count = 12, played = [] } = {}) {
  const body = {
    feed_mode: "track",
    preference_mode: preference,
    count,
    played_media: played.slice(0, 30),
    feed_counts: { mix_session_count: played.length },
    feed_preference: sceneId == null ? { preference_mode: preference } : { scene_mode_id: Number(sceneId) },
  };
  const json = await request("POST", "/luna/pc/feed/song-tab", { body });
  return tracksFrom(json.items);
}

function parseKrc(content) {
  if (typeof content !== "string" || !content.trim()) return [];
  const lines = [];
  for (const raw of content.split(/\r?\n/)) {
    const head = /^\[(\d+),(\d+)\]/.exec(raw);
    if (!head) continue;
    const start = Number(head[1]);
    const end = start + Number(head[2]);
    const rest = raw.slice(head[0].length);
    const marks = [];
    for (const mark of rest.matchAll(/<(\d+),(\d+),?\d*>/g)) {
      marks.push({
        at: mark.index,
        tagEnd: mark.index + mark[0].length,
        offset: Number(mark[1]),
        duration: Number(mark[2]),
      });
    }
    if (!marks.length) {
      const text = rest.trim();
      if (text) lines.push({ start, end, text, words: [{ start, end, text }] });
      continue;
    }
    const words = marks.map((mark, index) => ({
      text: rest.slice(mark.tagEnd, marks[index + 1] ? marks[index + 1].at : rest.length),
      start: start + mark.offset,
      end: start + mark.offset + mark.duration,
    }));
    lines.push({ start, end, text: words.map((word) => word.text).join(""), words });
  }
  return lines;
}

function parseVideoModel(raw) {
  let model = raw;
  if (typeof raw === "string") {
    try {
      model = parseJson(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(model?.video_list)) return [];
  const duration = typeof model.video_duration === "number" ? Math.round(model.video_duration * 1000) : undefined;
  return model.video_list
    .map((item) => {
      if (item?.encrypt_info || typeof item?.main_url !== "string") return null;
      const meta = item.video_meta || {};
      return {
        quality: String(meta.quality || "unknown"),
        url: item.main_url,
        backup: typeof item.backup_url === "string" ? item.backup_url : "",
        duration,
        bytes: Number(meta.size) || 0,
        bitrate: Number(meta.bitrate) || 0,
        container: String(meta.vtype || ""),
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.bitrate - a.bitrate);
}

async function trackDetail(id) {
  const key = String(id);
  const hit = detailCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.detail;
  const url = new URL("/luna/h5/track_v2", API);
  url.searchParams.set("track_id", key);
  url.searchParams.set("device_platform", "web");
  const headers = { "user-agent": BROWSER_UA, accept: "application/json" };
  const cookie = cookieHeader();
  if (cookie) headers.cookie = cookie;
  let response;
  try {
    response = await fetch(url, { headers });
  } catch {
    throw new Error(t("Could not reach Soda Music"));
  }
  const json = await readBody(response);
  statusError(json, "track");
  const track = json.track;
  if (!track?.id) problem("unavailable", "This song can't be played");
  const detail = {
    track: toTrack(track),
    lines: parseLyrics(json.lyric),
    qualities: parseVideoModel(json.track_player?.video_model),
    fullDuration: Number(track.duration) || 0,
  };
  detailCache.set(key, { at: Date.now(), detail });
  return detail;
}

function audioType(quality) {
  const container = quality.container.toLowerCase();
  const url = quality.url.toLowerCase();
  if (container.includes("flac") || url.includes("audio_flac")) return "flac";
  if (container.includes("mp3") || url.includes("audio_mp3") || url.includes("audio_mpeg")) return "mp3";
  if (url.includes("audio_aac") || (container === "aac" && !url.includes("audio_mp4"))) return "aac";
  return "m4a";
}

function pickQuality(qualities, asked) {
  if (!qualities.length) return null;
  const alias = {
    low: "medium",
    standard: "medium",
    medium: "medium",
    high: "higher",
    higher: "higher",
    exhigh: "highest",
    highest: "highest",
    lossless: "lossless",
    hires: "lossless",
    "hi-res": "lossless",
  };
  const name = alias[String(asked || "").toLowerCase()];
  if (name) {
    const found = qualities.find((quality) => quality.quality === name);
    if (found) return found;
  }
  return qualities[0];
}

async function passport(method, path, { query = {}, form } = {}) {
  const device = await ensureDevice();
  const url = new URL(path, API);
  const params = {
    aid: APP_ID,
    device_id: device.deviceId,
    iid: device.installId,
    cdid: device.cdid,
    device_platform: "PC",
    version_code: APP_VERSION,
    version_name: APP_VERSION,
    channel: CHANNEL,
    os: "Windows",
    language: "zh",
    ...JSSDK,
    ...query,
  };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const headers = { "user-agent": USER_AGENT, accept: "application/json" };
  const cookie = cookieHeader();
  if (cookie) headers.cookie = cookie;
  let body;
  if (form) {
    headers["content-type"] = "application/x-www-form-urlencoded";
    body = new URLSearchParams(form).toString();
  }
  let response;
  try {
    response = await fetch(url, { method, headers, body });
  } catch {
    throw new Error(t("Could not reach Soda Music"));
  }
  return readBody(response);
}

function scanUrl(data) {
  let token = data.token;
  if (data.qrcode_index_url) {
    try {
      token = new URL(data.qrcode_index_url).searchParams.get("token") || token;
    } catch {
      // keep the token from get_qrcode
    }
  }
  const url = new URL("https://bff-pc.qishui.com/light/invoke/scan_login");
  url.searchParams.set("token", token);
  url.searchParams.set("os", "Windows");
  url.searchParams.set("computer_name", COMPUTER_NAME);
  return url.toString().replaceAll("+", "%20");
}

export async function signIn() {
  const common = {};
  const created = await passport("GET", "/passport/web/get_qrcode/", {
    query: { ...common, next: API, need_logo: "false", need_short_url: "false", is_new_login: "1" },
  });
  const data = created?.data ?? {};
  if (!data.token) throw new Error(t("Could not reach Soda Music"));
  const qr = scanUrl(data);
  host.signInPrompt?.({ qr, text: t("Scan with the Soda Music app") });
  let expiresAt = Number(data.expire_time);
  if (!Number.isFinite(expiresAt)) expiresAt = Date.now() + 240_000;
  else if (expiresAt < 1e12) expiresAt *= 1000;
  if (expiresAt < Date.now() + 5_000) expiresAt = Date.now() + 240_000;
  expiresAt = Math.min(expiresAt, Date.now() + 270_000);
  let scanned = false;
  while (Date.now() < expiresAt) {
    const checked = await passport("POST", "/passport/web/check_qrconnect/", {
      form: {
        need_logo: "false",
        need_short_url: "false",
        is_frontier: "true",
        token: data.token,
        is_new_login: "1",
        next: API,
      },
    });
    const status = QR_STATUS[String(checked?.data?.status ?? "")] || "unknown";
    if (status === "confirmed") {
      if (!loggedIn()) throw new Error(t("Soda Music didn't finish signing in."));
      meCache = null;
      invalidateLibrary();
      return;
    }
    if (status === "expired") problem("signIn", "The QR code expired. Sign in again.");
    if (status === "scanned" && !scanned) {
      scanned = true;
      host.signInPrompt?.({ qr, text: t("Confirm the login on your phone") });
    }
    await sleep(2000);
  }
  throw new Error(t("Signing in timed out. Try again."));
}

export async function signOut() {
  const session = load();
  session.cookies = {};
  save();
  meCache = null;
  invalidateLibrary();
  detailCache.clear();
}

async function profile() {
  requireLogin();
  if (meCache) return meCache;
  const json = await request("GET", "/luna/pc/me");
  meCache = json.my_info || json.user || {};
  return meCache;
}

export async function account() {
  if (!loggedIn()) return null;
  try {
    const info = await profile();
    return {
      id: info.id == null ? "" : String(info.id),
      name: info.nickname || info.name || t("Soda Music"),
      imageUrl: imageOf(info.larger_avatar_url || info.medium_avatar_url || info.avatar_url),
      page: "me",
    };
  } catch (error) {
    if (error.code === "signIn") return null;
    throw error;
  }
}

export async function home() {
  const [feed, page] = await Promise.all([songFeed({ preference: "default", count: 30 }), discover()]);
  const { playlists, charts } = discoverParts(page);
  const sections = [];
  if (feed.length) {
    sections.push({
      title: t("For You"),
      subtitle: t("Picked from what you play"),
      pageTitle: t("For You"),
      tracks: feed,
    });
  } else if (charts[0]?.tracks?.length) {
    sections.push({ title: charts[0].title, pageTitle: charts[0].title, tracks: charts[0].tracks.slice(0, 30) });
  }
  if (playlists.length) sections.push({ title: t("Recommended Playlists"), playlists: playlists.slice(0, 18) });
  const links = charts
    .filter((chart) => chart.id)
    .map((chart) => ({ title: chart.title, subtitle: chart.description, page: `chart:${chart.id}` }));
  if (links.length) sections.push({ title: t("Charts"), links });
  return { title: t("Soda Music"), sections };
}

export async function browse({ page }) {
  if (page === "history") {
    const tracks = await recent();
    return {
      title: t("Play History"),
      subtitle: t("Songs you played"),
      sections: [{ title: t("Play History"), tracks, empty: t("Songs you played") }],
    };
  }
  if (page === "charts") {
    const { charts } = discoverParts(await discover());
    return {
      title: t("Charts"),
      sections: [
        {
          title: t("Charts"),
          links: charts
            .filter((chart) => chart.id)
            .map((chart) => ({ title: chart.title, subtitle: chart.description, page: `chart:${chart.id}` })),
        },
      ],
    };
  }
  if (page === "me") {
    const info = await profile();
    return {
      title: info.nickname || t("Soda Music"),
      subtitle: info.signature || "",
      imageUrl: imageOf(info.larger_avatar_url || info.medium_avatar_url),
      sections: [],
    };
  }
  if (String(page).startsWith("chart:")) {
    const id = String(page).slice("chart:".length);
    const json = await request("GET", `/luna/pc/charts/${encodeURIComponent(id)}`);
    const chart = json.chart || {};
    const tracks = (chart.track_ranks || []).map((row) => toTrack(row.track)).filter(Boolean);
    return {
      title: chart.title || t("Charts"),
      description: chart.style?.desc || chart.desc || "",
      sections: [{ title: chart.title || t("Charts"), tracks }],
    };
  }
  problem("unsupported", "That page isn't available");
}

const SEARCH_TYPE = { tracks: "track", albums: "album", artists: "artist", playlists: "playlist" };

export async function search({ query, kind, offset }) {
  const type = SEARCH_TYPE[kind];
  if (!type) return { more: false };
  const key = `${kind}\0${query}`;
  if (!offset) searchIds.set(key, uuid());
  const searchId = searchIds.get(key) || uuid();
  const json = await request("GET", `/luna/search/${type}`, {
    query: {
      q: query,
      cursor: String(offset || 0),
      search_id: searchId,
      search_method: type,
    },
  });
  const groups = json.result_groups || [];
  const items = groups.flatMap((group) => group.items || []);
  const more = groups.some((group) => group.has_more);
  if (kind === "tracks") return { tracks: tracksFrom(items), more };
  if (kind === "albums") return { albums: items.map((item) => toAlbum(item.entity?.album)).filter(Boolean), more };
  if (kind === "artists") return { artists: items.map((item) => toArtist(item.entity?.artist)).filter(Boolean), more };
  return { playlists: items.map((item) => toPlaylist(item.entity?.playlist)).filter(Boolean), more };
}

export async function suggest({ query }) {
  if (!query) return [];
  const json = await request("GET", "/luna/pc/sug", {
    query: { q: query, sug_scene: "search_sug", sug_search_id: "" },
  });
  return (json.sugs || []).map((item) => item.suggestion).filter(Boolean);
}

export async function recent() {
  if (!loggedIn()) return [];
  const json = await request("GET", "/luna/me/recently-played", { query: { cursor: "0", count: "50" } });
  return tracksFrom(json.tracks || json.media);
}

export async function played({ id }) {
  if (!loggedIn() || !id) return;
  try {
    await request("POST", "/luna/me/recently-played", { body: { track_ids: [String(id)] } });
  } catch (error) {
    console.error(error);
  }
}

async function playlistPage(id, cursor, count) {
  const json = await request("GET", "/luna/pc/playlist/detail", {
    query: { playlist_id: String(id), cursor: String(cursor ?? 0), count: String(count) },
  });
  const tracks = tracksFrom(json.media_resources || json.tracks);
  const more = json.has_more === true || (json.has_more == null && Boolean(json.next_cursor) && String(json.next_cursor) !== String(cursor) && tracks.length > 0);
  return { json, tracks, more };
}

export async function liked({ offset = 0 } = {}) {
  const favorite = await favoritePlaylist();
  if (!favorite) return { tracks: [], more: false };
  const page = await playlistPage(favorite.id, offset, 50);
  return { tracks: page.tracks, more: page.more };
}

export async function isLiked({ ids }) {
  requireLogin();
  if (!likedCache) {
    const favorite = await favoritePlaylist();
    const idsIn = new Set();
    if (favorite) {
      const page = await playlistPage(favorite.id, 0, 200);
      for (const track of page.tracks) idsIn.add(track.id);
    }
    likedCache = idsIn;
  }
  const out = {};
  for (const id of ids || []) out[id] = likedCache.has(String(id));
  return out;
}

export async function like({ id, on }) {
  requireLogin();
  const path = on ? "/luna/me/collection/track" : "/luna/me/collection/track/delete";
  await request("POST", path, { body: { track_ids: [String(id)] } });
  if (likedCache) {
    if (on) likedCache.add(String(id));
    else likedCache.delete(String(id));
  }
}

export async function album({ id }) {
  const json = await request("GET", `/luna/pc/albums/${encodeURIComponent(id)}`);
  const info = json.album_info || json.album || { id };
  if (info.id == null) info.id = id;
  return { album: toAlbum(info), tracks: (json.tracks || []).map(toTrack).filter(Boolean) };
}

export async function artist({ id }) {
  const [detail, listed] = await Promise.all([
    request("GET", `/luna/pc/artists/${encodeURIComponent(id)}`),
    request("GET", `/luna/pc/artists/${encodeURIComponent(id)}/tracks`, { query: { cursor: "0", count: "50" } }),
  ]);
  const info = detail.artist_info || detail.artist || { id };
  if (info.id == null) info.id = id;
  return {
    artist: toArtist(info),
    tracks: (listed.tracks || []).map(toTrack).filter(Boolean),
    albums: (detail.hot_albums || []).map(toAlbum).filter(Boolean),
  };
}

export async function playlists() {
  const list = await myPlaylists();
  return list.map((playlist) => toPlaylist(playlist, { mine: true })).filter(Boolean);
}

export async function playlist({ id }) {
  const owned = (libraryCache || []).find((item) => String(item.id) === String(id));
  const page = await playlistPage(id, 0, 200);
  const info = page.json.playlist || owned || { id };
  const mapped = toPlaylist(info, { mine: Boolean(owned) }) || {
    id: String(id),
    name: "Playlist",
    mine: Boolean(owned),
  };
  if (owned) {
    mapped.mine = true;
    mapped.fixed = Number(owned.type) === 1 || Number(owned.type) === 4;
  }
  mapped.tracks = page.tracks;
  mapped.trackCount = mapped.trackCount || page.tracks.length;
  return mapped;
}

export async function createPlaylist({ name }) {
  requireLogin();
  const json = await request("POST", "/luna/pc/me/playlist", { body: { name, is_private: false } });
  invalidateLibrary();
  return toPlaylist(json.playlist || { id: json.id, title: name, type: 2 }, { mine: true });
}

export async function renamePlaylist({ id, name }) {
  requireLogin();
  try {
    await request("POST", "/luna/pc/me/playlist/update", { body: { playlist_id: String(id), name } });
  } catch (error) {
    if (!String(error.message).includes("1000014")) throw error;
    await request("POST", "/luna/pc/me/playlist/update", { body: { playlist_id: String(id), name } });
  }
  invalidateLibrary();
}

export async function deletePlaylist({ id }) {
  requireLogin();
  await request("POST", "/luna/pc/me/playlist/delete", { body: { playlist_ids: [String(id)] } });
  invalidateLibrary();
}

function mediaBody(id, trackIds) {
  return {
    playlist_id: String(id),
    media: (trackIds || []).map((trackId) => ({ id: String(trackId), type: "track" })),
  };
}

export async function addToPlaylist({ id, trackIds }) {
  requireLogin();
  await request("POST", "/luna/pc/me/playlist/media/append", { body: mediaBody(id, trackIds) });
}

export async function removeFromPlaylist({ id, trackIds }) {
  requireLogin();
  await request("POST", "/luna/pc/me/playlist/media/delete", { body: mediaBody(id, trackIds) });
}

export async function stations() {
  const modes = [
    { id: "pref:default", name: t("Default"), description: t("A mix based on what you play") },
    { id: "pref:familiar", name: t("Familiar"), description: t("Songs you already know") },
    { id: "pref:fresh", name: t("Fresh"), description: t("Songs you have not played much") },
  ];
  try {
    const json = await request("POST", "/luna/pc/feed/mode", { body: {} });
    for (const block of json.feed_mode_block || []) {
      for (const mode of block.feed_mode || []) {
        const scene = mode.entity?.feed_scene_mode || {};
        if (scene.scene_mode_id == null || !mode.text) continue;
        modes.push({
          id: `scene:${scene.scene_mode_id}`,
          name: mode.text,
          description: scene.sub_queue_type ? String(scene.sub_queue_type) : "",
        });
      }
    }
  } catch (error) {
    console.error(error);
  }
  return modes;
}

export async function stationNext({ id }) {
  const played = stationPlayed.get(id) || [];
  const scene = String(id).startsWith("scene:") ? String(id).slice("scene:".length) : null;
  const preference = String(id).startsWith("pref:") ? String(id).slice("pref:".length) : "default";
  const tracks = await songFeed({ preference, sceneId: scene, count: 12, played });
  const next = played.slice();
  for (const track of tracks) {
    next.unshift({
      type: "track",
      media_id: track.id,
      duration: Math.round((track.duration || 0) / 1000),
      played_mills: -1,
    });
  }
  stationPlayed.set(id, next.slice(0, 30));
  return tracks;
}

export async function lyrics({ id }) {
  const detail = await trackDetail(id);
  if (!detail.lines.length) return { lines: [] };
  return { lines: detail.lines };
}

export async function stream({ id, quality }) {
  const detail = await trackDetail(id);
  const chosen = pickQuality(detail.qualities, quality);
  if (!chosen) problem("unavailable", "This song can't be played");
  const preview = chosen.duration && detail.fullDuration && chosen.duration < detail.fullDuration - 15000;
  return {
    url: chosen.url,
    type: audioType(chosen),
    quality: preview ? `${chosen.quality}-preview` : chosen.quality,
    bitRate: chosen.bitrate || undefined,
    size: chosen.bytes || undefined,
    headers: { referer: "https://www.qishui.com/", "user-agent": BROWSER_UA },
  };
}
