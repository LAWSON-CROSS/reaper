"use strict";
const HOST = "reaper_host";
const R = self.REAPER;

let settings = JSON.parse(JSON.stringify(R.DEFAULTS));
let queue = [];
let running = false;
let port = null;
let host = { status: "unknown" };   // unknown | connecting | ok | missing
let notice = null;                  // one-off message for the popup
let stats = { done: 0, failed: 0 };
let ready;

// ---------- persistence ----------
function mergeSettings(saved) {
  const s = JSON.parse(JSON.stringify(R.DEFAULTS));
  if (saved && typeof saved === "object") {
    for (const k of ["outDir", "concurrency", "gpu", "cookies", "autoStart"]) if (k in saved) s[k] = saved[k];
    Object.assign(s.video, saved.video || {});
    Object.assign(s.audio, saved.audio || {});
  }
  if (!R.VCODECS[s.video.vcodec]) s.video = { ...R.DEFAULTS.video };
  if (!R.ACODECS[s.audio.acodec]) s.audio = { ...R.DEFAULTS.audio };
  s.concurrency = Math.min(4, Math.max(1, parseInt(s.concurrency, 10) || 2));
  return s;
}
ready = browser.storage.local.get(["settings", "queue"]).then((d) => {
  settings = mergeSettings(d.settings);
  queue = Array.isArray(d.queue) ? d.queue : [];
  for (const j of queue) if (j.status === "active") Object.assign(j, { status: "queued", percent: 0, stage: "" });
  refreshIcon();
});
let saveTimer = null;
function saveQueue() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => browser.storage.local.set({ queue }), 200);
}

// ---------- state for the popup ----------
function snapshot() {
  const n = notice; notice = null;
  return { settings, queue, running, host, notice: n };
}
let pushTimer = null;
function push(now) {
  refreshIcon();
  if (pushTimer && !now) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => {
    pushTimer = null;
    browser.runtime.sendMessage({ type: "state", state: snapshot() }).catch(() => {});
  }, now ? 0 : 150);
}

// ---------- toolbar icon ----------
const frames = { idle: null, anim: [] };
function img(data, size) { return new ImageData(data, size, size); }
function buildFrames() {
  frames.idle = { 16: img(ScytheSprite.idle(16), 16), 32: img(ScytheSprite.idle(32), 32) };
  for (let i = 0; i < ScytheSprite.frameCount; i++)
    frames.anim.push({ 16: img(ScytheSprite.frame(i, 16), 16), 32: img(ScytheSprite.frame(i, 32), 32) });
}
let animTimer = null, animIndex = 0;
function refreshIcon() {
  const pending = queue.filter((j) => j.status === "queued" || j.status === "active").length;
  const active = queue.some((j) => j.status === "active");
  browser.browserAction.setBadgeText({ text: pending ? String(pending) : "" });
  browser.browserAction.setTitle({ title: pending ? `Reaper — ${pending} in queue` : "Reaper" });
  if (active && !animTimer) {
    animIndex = 0;
    animTimer = setInterval(() => {
      browser.browserAction.setIcon({ imageData: frames.anim[animIndex] });
      animIndex = (animIndex + 1) % frames.anim.length;
      // finish the swing before going back to rest
      if (animIndex === 0 && !queue.some((j) => j.status === "active")) {
        clearInterval(animTimer); animTimer = null;
        browser.browserAction.setIcon({ imageData: frames.idle });
      }
    }, 75);
  }
}
try {
  buildFrames();
  browser.browserAction.setBadgeBackgroundColor({ color: "#12d6a0" });
  browser.browserAction.setBadgeTextColor({ color: "#0b1512" });
} catch (e) { console.error(e); }

// ---------- helper app connection ----------
let idleTimer = null, busy = 0;
function connect() {
  clearTimeout(idleTimer);
  if (port) return;
  host = { status: "connecting" };
  try {
    port = browser.runtime.connectNative(HOST);
  } catch (e) {
    port = null; host = { status: "missing", error: String(e.message || e) };
    return;
  }
  const p = port;
  p.onMessage.addListener(onHost);
  p.onDisconnect.addListener(() => {
    if (port !== p) return;
    const err = (p.error && p.error.message) || (browser.runtime.lastError && browser.runtime.lastError.message) || "";
    port = null; busy = 0;
    const wasOk = host.status === "ok";
    host = wasOk && !err ? { ...host, status: "unknown" } : { status: "missing", error: err };
    for (const j of queue) if (j.status === "active") Object.assign(j, { status: "queued", percent: 0, stage: "" });
    if (running) { running = false; if (!wasOk || err) notice = "Lost contact with the helper app."; }
    saveQueue(); push(true);
  });
  p.postMessage({ type: "hello" });
}
function restIfIdle() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (busy > 0) return restIfIdle();
    if (port && !running && !queue.some((j) => j.status === "active")) {
      const p = port; port = null; p.disconnect();
      if (host.status === "ok") host = { ...host, status: "unknown" };
    }
  }, 60000);
}
function post(msg) {
  connect();
  if (!port) return false;
  try { port.postMessage(msg); return true; } catch (e) { return false; }
}

function onHost(m) {
  const job = m.id ? queue.find((j) => j.id === m.id) : null;
  switch (m.type) {
    case "hello":
      host = { status: "ok", version: m.version, ytdlp: m.ytdlp || "", ffmpeg: !!m.ffmpeg, deno: !!m.deno, defaultDir: m.defaultDir || "", updating: false };
      push(true); restIfIdle();
      return;
    case "progress":
      if (job && job.status === "active") { job.stage = m.stage; job.percent = m.percent; job.detail = m.detail; push(); }
      return;
    case "done":
      if (job) { Object.assign(job, { status: "done", percent: 100, stage: "", detail: "", files: m.files || [] }); stats.done++; }
      break;
    case "error":
      if (job) { Object.assign(job, { status: "error", error: m.message || "Failed", stage: "", detail: "" }); stats.failed++; }
      break;
    case "cancelled":
      if (job && job.status === "active") Object.assign(job, { status: "queued", percent: 0, stage: "", detail: "" });
      break;
    case "folder":
      busy = Math.max(0, busy - 1);
      if (m.path) { settings.outDir = m.path; browser.storage.local.set({ settings }); notice = "Download folder set."; }
      push(true);
      return;
    case "updateResult":
      busy = Math.max(0, busy - 1);
      host.updating = false; notice = m.output || (m.ok ? "yt-dlp is up to date." : "Update failed.");
      push(true);
      return;
    default:
      return;
  }
  saveQueue(); pump(); push(true);
}

// ---------- queue ----------
function jobSettings(mode) {
  const v = settings.video, a = settings.audio;
  return { container: v.container, vcodec: v.vcodec, resolution: v.resolution, vbitrate: v.vbitrate, acodec: a.acodec, abitrate: a.abitrate, gpu: settings.gpu, cookies: settings.cookies };
}
function jobLabel(mode) {
  if (mode === "audio") return R.audioLabel(settings.audio);
  if (mode === "video") return R.videoLabel(settings.video) + " · silent";
  return R.videoLabel(settings.video) + " + audio";
}
function addTab(tab, mode) {
  const s = R.site(tab.url);
  if (!s) return "unsupported";
  if (s.audioOnly) mode = "audio";
  if (queue.some((j) => j.url === s.url && j.mode === mode && (j.status === "queued" || j.status === "active"))) return "duplicate";
  queue.push({
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 7),
    url: s.url, site: s.site, title: R.cleanTitle(tab.title), mode,
    status: "queued", percent: 0, stage: "", detail: "",
    settings: jobSettings(mode), label: jobLabel(mode), outDir: settings.outDir,
  });
  return "added";
}
function pump() {
  if (!running) return;
  let active = queue.filter((j) => j.status === "active").length;
  for (const j of queue) {
    if (active >= settings.concurrency) break;
    if (j.status !== "queued") continue;
    if (!post({ type: "download", id: j.id, url: j.url, mode: j.mode, outDir: j.outDir || settings.outDir, settings: j.settings })) break;
    Object.assign(j, { status: "active", percent: 0, stage: "Starting", detail: "" });
    active++;
  }
  if (active === 0 && !queue.some((j) => j.status === "queued")) {
    running = false;
    if (stats.done + stats.failed > 0) {
      browser.notifications.create("reaper-done", {
        type: "basic", iconUrl: browser.runtime.getURL("icons/scythe-96.png"), title: "Reaper",
        message: `${stats.done} download${stats.done === 1 ? "" : "s"} finished` + (stats.failed ? `, ${stats.failed} failed` : "") + ".",
      }).catch(() => {});
    }
    restIfIdle();
  }
}
function start() {
  if (!queue.some((j) => j.status === "queued")) return;
  connect();
  if (!port) return;
  if (!running) stats = { done: 0, failed: 0 };
  running = true;
  pump();
}
function stop() {
  running = false;
  for (const j of queue) if (j.status === "active") post({ type: "cancel", id: j.id });
}

// ---------- popup API ----------
const supportedTabs = async () => (await browser.tabs.query({ currentWindow: true })).filter((t) => R.site(t.url));

browser.runtime.onMessage.addListener(async (msg) => {
  if (!msg || msg.type === "state") return;
  await ready;
  switch (msg.type) {
    case "open":           // popup opened
      connect();
      if (port && host.status === "ok") restIfIdle();
      break;
    case "add": {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      const r = tab ? addTab(tab, msg.mode) : "unsupported";
      if (r === "duplicate") notice = "Already in the queue.";
      if (r === "added" && settings.autoStart) start();
      break;
    }
    case "addAll": {
      let n = 0;
      for (const t of await supportedTabs()) if (addTab(t, msg.mode) === "added") n++;
      notice = n ? `Queued ${n} tab${n === 1 ? "" : "s"}.` : "Those tabs are already queued.";
      if (n && settings.autoStart) start();
      break;
    }
    case "remove": {
      const j = queue.find((j) => j.id === msg.id);
      if (j && j.status === "active") post({ type: "cancel", id: j.id });
      queue = queue.filter((j) => j.id !== msg.id);
      pump();
      break;
    }
    case "retry": {
      const j = queue.find((j) => j.id === msg.id);
      if (j) { Object.assign(j, { status: "queued", percent: 0, error: "", stage: "" }); if (running) pump(); }
      break;
    }
    case "clearDone": queue = queue.filter((j) => j.status === "queued" || j.status === "active"); break;
    case "clearAll": stop(); queue = []; break;
    case "start": start(); break;
    case "stop": stop(); break;
    case "settings":
      settings = mergeSettings(msg.settings);
      await browser.storage.local.set({ settings });
      break;
    case "pickFolder": if (post({ type: "pickFolder", path: settings.outDir || host.defaultDir || "" })) busy++; break;
    case "openFolder": post({ type: "openFolder", path: msg.path || settings.outDir || host.defaultDir || "" }); break;
    case "update": if (post({ type: "update" })) { busy++; host.updating = true; } break;
  }
  saveQueue();
  refreshIcon();
  const tabs = await supportedTabs();
  const [cur] = await browser.tabs.query({ active: true, currentWindow: true });
  return { ...snapshot(), tab: cur ? { title: R.cleanTitle(cur.title), site: R.site(cur.url) } : null, tabCount: tabs.length };
});
