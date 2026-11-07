import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const storage = new Map();
const prompts = [];

globalThis.host = {
  storage: {
    get: (key) => storage.get(key) ?? null,
    set: (key, value) => storage.set(key, value),
    remove: (key) => storage.delete(key),
  },
  crypto: { md5: (text) => createHash("md5").update(text).digest("hex") },
  t: (text) => text,
  signInPrompt: (prompt) => prompts.push(prompt),
};

const plugin = await import("../index.js");

function jsonResponse(body, { status = 200, headers = {} } = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return new Response(text, { status, headers: { "content-type": "application/json", ...headers } });
}

globalThis.fetch = async (input, init = {}) => {
  const url = input instanceof URL ? input : new URL(typeof input === "string" ? input : input.url);
  const path = url.pathname;
  if (path.startsWith("/service/2/desktop/device_register")) {
    return jsonResponse({ device_id_str: "7123456789012345678", install_id_str: "7987654321098765432" });
  }
  if (path === "/passport/web/get_qrcode/") {
    return jsonResponse({
      data: {
        token: "qr-token",
        expire_time: Math.floor(Date.now() / 1000) + 120,
        qrcode_index_url: "https://api.qishui.com/passport/web/scan/?token=index-token",
      },
    });
  }
  if (path === "/passport/web/check_qrconnect/") {
    return jsonResponse(
      { data: { status: "confirmed" } },
      { headers: { "set-cookie": "sessionid=sess-1; Path=/; Domain=.qishui.com" } },
    );
  }
  if (path === "/luna/pc/me" && init.method !== "POST") {
    return jsonResponse({ status_code: 0, my_info: { id: "42", nickname: "周韬", signature: "hi" } });
  }
  if (path === "/luna/pc/me/playlist" && (init.method || "GET") === "GET") {
    return jsonResponse({
      status_code: 0,
      playlists: [
        { id: "11", title: "我喜欢的音乐", type: 1, count_tracks: 2 },
        { id: "22", title: "自建", type: 2, count_tracks: 1 },
        { id: "33", title: "抖音收藏的音乐", type: 4, count_tracks: 0 },
      ],
    });
  }
  if (path === "/luna/pc/playlist/detail") {
    return jsonResponse({
      status_code: 0,
      has_more: false,
      playlist: { id: url.searchParams.get("playlist_id"), title: "歌单", count_tracks: 1 },
      media_resources: [
        {
          entity: {
            track_wrapper: {
              track: {
                id: 7673377691022084142,
                name: "时梦",
                duration: 180000,
                artists: [{ id: 9, name: "Rorik" }],
                album: { id: 8, name: "专辑" },
              },
            },
          },
        },
      ],
    });
  }
  if (path === "/luna/pc/discover") {
    return jsonResponse({
      status_code: 0,
      blocks: [
        {
          inner_block: [
            {
              type: "discover_playlist",
              resources: [{ entity: { playlist: { id: "99", title: "推荐", count_tracks: 10 } } }],
            },
            {
              type: "discover_track_top_list",
              inner_block_id: "55",
              title: "热歌榜",
              desc: "每周更新",
              resources: [],
            },
          ],
        },
      ],
    });
  }
  if (path === "/luna/pc/feed/song-tab") {
    const body = JSON.parse(init.body);
    return jsonResponse({
      status_code: 0,
      items: [
        {
          entity: {
            track_wrapper: {
              track: { id: "1001", name: body.preference_mode || "song", duration: 1000, artists: [], album: {} },
            },
          },
        },
      ],
    });
  }
  if (path === "/luna/pc/feed/mode") {
    return jsonResponse({
      status_code: 0,
      feed_mode_block: [
        { feed_mode: [{ text: "图书馆", entity: { feed_scene_mode: { scene_mode_id: 8, sub_queue_type: "scene" } } }] },
      ],
    });
  }
  if (path === "/luna/search/track") {
    return jsonResponse(
      `{"status_code":0,"score":0.0001234567890123456789,"result_groups":[{"id":"tracks","has_more":false,"items":[{"entity":{"track":{"id":7673377691022084142,"name":"时梦","duration":291840,"artists":[{"id":1,"name":"Rorik"}],"album":{"id":2,"name":"专辑"}}}}]}]}`,
    );
  }
  if (path === "/luna/pc/sug") {
    return jsonResponse({ status_code: 0, sugs: [{ suggestion: "周杰伦" }, { suggestion: "晴天" }] });
  }
  if (path === "/luna/me/recently-played" && (init.method || "GET") === "GET") {
    return jsonResponse({
      status_code: 0,
      tracks: [{ id: "1001", name: "听过", duration: 2000, artists: [{ id: "3", name: "甲" }], album: { name: "" } }],
    });
  }
  if (path === "/luna/me/recently-played") {
    return jsonResponse({ status_code: 0 });
  }
  if (path === "/luna/h5/track_v2") {
    return jsonResponse({
      status_code: 0,
      track: { id: url.searchParams.get("track_id"), name: "时梦", duration: 291840, artists: [{ name: "Rorik" }], album: {} },
      lyric: { content: "[0,1000]<0,500,0>时<500,500,0>梦\n[1000,1000]作词：Rorik" },
      track_player: {
        video_model: JSON.stringify({
          video_duration: 291.84,
          video_list: [
            { encrypt_info: { key: "nope" }, main_url: "https://cdn.example/encrypted", video_meta: { quality: "lossless", bitrate: 900 } },
            { main_url: "https://v5-luna.douyinvod.com/a.m4a?mime_type=audio_mp4", video_meta: { quality: "higher", bitrate: 256, size: 100, vtype: "m4a" } },
          ],
        }),
      },
    });
  }
  if (path === "/luna/pc/me" && init.method === "POST") return jsonResponse({ status_code: 1000016 });
  return jsonResponse({ status_code: 0 });
};

test("app QR sign-in stores the session and never asks for a cookie", async () => {
  assert.equal(await plugin.account(), null);
  await plugin.signIn();
  assert.equal(prompts[0].qr.includes("scan_login"), true);
  assert.equal(prompts[0].qr.includes("token=index-token"), true);
  assert.equal(prompts[0].text, "Scan with the Soda Music app");
  const who = await plugin.account();
  assert.equal(who.name, "周韬");
  assert.equal(who.page, "me");
  const saved = storage.get("session");
  assert.equal(saved.cookies.sessionid, "sess-1");
  assert.equal(saved.device.deviceId, "7123456789012345678");
});

test("playlists keep liked and Douyin collections fixed", async () => {
  const list = await plugin.playlists();
  assert.deepEqual(
    list.map((playlist) => [playlist.name, playlist.mine, playlist.fixed]),
    [
      ["我喜欢的音乐", true, true],
      ["自建", true, false],
      ["抖音收藏的音乐", true, true],
    ],
  );
});

test("search keeps 64-bit track ids and suggest returns phrases", async () => {
  const found = await plugin.search({ query: "时梦", kind: "tracks", offset: 0 });
  assert.equal(found.tracks[0].id, "7673377691022084142");
  assert.equal(found.tracks[0].artists[0].name, "Rorik");
  assert.deepEqual(await plugin.suggest({ query: "周" }), ["周杰伦", "晴天"]);
});

test("home, listening modes, history, lyrics and stream", async () => {
  const page = await plugin.home();
  assert.equal(page.sections[0].title, "For You");
  assert.equal(page.sections[1].playlists[0].name, "推荐");
  assert.equal(page.sections[2].links[0].page, "chart:55");

  const modes = await plugin.stations();
  assert.equal(modes[0].id, "pref:default");
  assert.equal(modes[1].id, "pref:familiar");
  assert.equal(modes[2].id, "pref:fresh");
  assert.equal(modes[3].id, "scene:8");
  assert.equal(modes[3].name, "图书馆");

  const next = await plugin.stationNext({ id: "pref:familiar" });
  assert.equal(next[0].name, "familiar");

  const history = await plugin.recent();
  assert.equal(history[0].name, "听过");
  const historyPage = await plugin.browse({ page: "history" });
  assert.equal(historyPage.sections[0].tracks[0].id, "1001");

  const words = await plugin.lyrics({ id: "7673377691022084142" });
  assert.equal(words.lines[0].text, "时梦");
  assert.equal(words.lines[0].words[1].text, "梦");
  assert.equal(words.lines[0].words[1].start, 500);
  assert.equal(words.lines[1].text, "作词：Rorik");

  const audio = await plugin.stream({ id: "7673377691022084142", quality: "highest" });
  assert.equal(audio.type, "m4a");
  assert.equal(audio.url.includes("douyinvod.com"), true);
  assert.equal(audio.url.includes("encrypted"), false);
});

test("a signed-out account is empty after sign-out", async () => {
  await plugin.signOut();
  assert.equal(await plugin.account(), null);
  assert.deepEqual(await plugin.recent(), []);
});
