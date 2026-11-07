import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

const storage = new Map();
globalThis.host = {
  storage: {
    get: (key) => storage.get(key) ?? null,
    set: (key, value) => storage.set(key, value),
    remove: (key) => storage.delete(key),
  },
  crypto: { md5: (text) => createHash("md5").update(text).digest("hex") },
  t: (text) => text,
  signInPrompt: () => {},
};

const plugin = await import("../index.js");

test("anonymous home, a listening mode and a real stream URL", { timeout: 60_000 }, async () => {
  const page = await plugin.home();
  assert.ok(page.sections.length > 0, "home returned no sections");
  const tracks = page.sections.find((section) => section.tracks?.length)?.tracks;
  assert.ok(tracks?.length, "home returned no tracks");
  assert.match(tracks[0].id, /^\d{5,}$/);

  const modes = await plugin.stations();
  assert.ok(modes.some((mode) => mode.id === "pref:default"));
  const next = await plugin.stationNext({ id: "pref:default" });
  assert.ok(next.length > 0, "listening mode returned no tracks");

  const audio = await plugin.stream({ id: tracks[0].id });
  assert.match(audio.url, /^https:\/\//);
  assert.ok(["m4a", "mp3", "aac", "flac"].includes(audio.type), audio.type);
  const words = await plugin.lyrics({ id: tracks[0].id });
  assert.ok(Array.isArray(words.lines));

  const probe = await fetch(audio.url, {
    method: "GET",
    headers: { ...audio.headers, range: "bytes=0-1" },
  });
  assert.ok(probe.status === 200 || probe.status === 206, `audio HTTP ${probe.status}`);
  await probe.body?.cancel();
});
