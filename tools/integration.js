// Runs the real background.js against the real helper binary with a mocked `browser` API.
const vm = require("vm"), fs = require("fs"), path = require("path"), { spawn } = require("child_process");
const ext = path.join(__dirname, "../extension"), hostBin = process.argv[2], outDir = process.argv[3], mediaUrl = process.argv[4];
const log = { badge: [], icons: 0, notes: [], states: 0 };
const store = {};
let tabs = [];
const listeners = [];
function connectNative() {
  const p = spawn(hostBin, ["/x/reaper_host.json", "reaper@localhost"], { stdio: ["pipe", "pipe", "inherit"] });
  const on = { msg: [], disc: [] };
  let buf = Buffer.alloc(0);
  p.stdout.on("data", (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const n = buf.readUInt32LE(0), m = JSON.parse(buf.slice(4, 4 + n)); buf = buf.slice(4 + n);
      on.msg.forEach((f) => f(m));
    }
  });
  p.on("exit", () => on.disc.forEach((f) => f()));
  p.on("error", () => on.disc.forEach((f) => f()));
  return {
    onMessage: { addListener: (f) => on.msg.push(f) }, onDisconnect: { addListener: (f) => on.disc.push(f) },
    postMessage: (o) => { const b = Buffer.from(JSON.stringify(o)), h = Buffer.alloc(4); h.writeUInt32LE(b.length); p.stdin.write(Buffer.concat([h, b])); },
    disconnect: () => p.stdin.end(),
  };
}
const browser = {
  storage: { local: { get: async (k) => JSON.parse(JSON.stringify(store)), set: async (o) => { Object.assign(store, JSON.parse(JSON.stringify(o))); } } },
  runtime: { connectNative, sendMessage: async () => { log.states++; }, onMessage: { addListener: (f) => listeners.push(f) }, getURL: (p) => p, lastError: null },
  browserAction: { setBadgeText: ({ text }) => { if (log.badge[log.badge.length - 1] !== text) log.badge.push(text); }, setTitle() {}, setIcon: () => { log.icons++; }, setBadgeBackgroundColor() {}, setBadgeTextColor() {} },
  tabs: { query: async (q) => (q.active ? tabs.filter((t) => t.active) : tabs) },
  notifications: { create: async (id, o) => { log.notes.push(o.message); } },
};
class ImageData { constructor(d, w, h) { this.data = d; this.width = w; this.height = h; } }
const ctx = vm.createContext({ browser, ImageData, console, setTimeout, clearTimeout, setInterval, clearInterval, URL, Date, Math, JSON });
ctx.self = ctx;
for (const f of ["sprite.js", "presets.js", "background.js"]) vm.runInContext(fs.readFileSync(path.join(ext, f), "utf8"), ctx, { filename: f });
// let the local test clip stand in for YouTube / SoundCloud pages
const realSite = ctx.REAPER.site;
ctx.REAPER.site = (u) => (u.startsWith("http://127.0.0.1") ? { site: u.includes("sc=1") ? "soundcloud" : "youtube", url: u, audioOnly: u.includes("sc=1") } : realSite(u));
const send = (m) => listeners[0](m);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const assert = (c, msg) => { console.log((c ? "PASS " : "FAIL ") + msg); if (!c) process.exitCode = 1; };
(async () => {
  tabs = [
    { active: true, url: mediaUrl + "?a=1", title: "(3) First Clip - YouTube" },
    { active: false, url: mediaUrl + "?a=2", title: "Second Clip - YouTube" },
    { active: false, url: mediaUrl + "?sc=1", title: "Stream Tune by Someone | Listen online for free on SoundCloud" },
    { active: false, url: "https://example.com/", title: "Other" },
  ];
  let s = await send({ type: "open" });
  assert(s.tabCount === 3 && s.tab.title === "First Clip", "detects supported tabs and cleans the title");
  await sleep(1500);
  s = await send({ type: "open" });
  assert(s.host.status === "ok" && s.host.ffmpeg && s.host.ytdlp, "helper connects: yt-dlp " + s.host.ytdlp);

  await send({ type: "settings", settings: { ...s.settings, outDir, concurrency: 2, video: { container: "mov", vcodec: "h264", resolution: 720, vbitrate: 8000 }, audio: { acodec: "mp3", abitrate: 192 } } });
  s = await send({ type: "add", mode: "both" });
  assert(s.queue.length === 1 && s.queue[0].label === "H.264 720p · MOV + audio", "one click queues the tab: " + s.queue[0].label);
  s = await send({ type: "add", mode: "both" });
  assert(s.queue.length === 1 && s.notice === "Already in the queue.", "duplicate is ignored");
  s = await send({ type: "addAll", mode: "video" });
  assert(s.queue.length === 4, "queue-all adds the other tabs (" + s.queue.map((j) => j.mode).join(",") + ")");
  assert(s.queue[3].mode === "audio", "SoundCloud tab is forced to audio");
  assert(log.badge[log.badge.length - 1] === "4" && !s.running, "badge shows 4 and nothing has started yet");
  assert(JSON.stringify(store.settings.video).includes("mov"), "settings persisted to storage");

  s = await send({ type: "start" });
  assert(s.running && s.queue.filter((j) => j.status === "active").length === 2, "start runs 2 at once");
  for (let i = 0; i < 300 && (s = await send({ type: "open" })).running; i++) await sleep(300);
  console.log(s.queue.map((j) => `   ${j.mode} ${j.status} ${j.error || (j.files || []).map((f) => path.basename(f)).join()}`).join("\n"));
  assert(s.queue.every((j) => j.status === "done"), "all four finish");
  assert(log.badge[log.badge.length - 1] === "" && log.badge.includes("2"), "badge counts down: " + JSON.stringify(log.badge));
  assert(log.icons > 12, "icon animated (" + log.icons + " frames)");
  assert(log.notes[0] === "4 downloads finished.", "notification: " + log.notes[0]);

  // stop mid-run puts the job back in the queue; failures can be retried
  await send({ type: "clearDone" });
  await send({ type: "settings", settings: { ...s.settings, outDir, video: { container: "mov", vcodec: "prores_hq", resolution: 0, vbitrate: 0 } } });
  await send({ type: "add", mode: "both" });
  tabs[0].url = "http://127.0.0.1:9/nope.mp4";
  await send({ type: "add", mode: "audio" });
  await send({ type: "start" });
  await sleep(2500);
  s = await send({ type: "stop" });
  await sleep(1500);
  s = await send({ type: "open" });
  assert(!s.running && s.queue[0].status === "queued", "stop returns the active job to the queue");
  assert(s.queue[1].status === "error" && s.queue[1].error, "bad link reports an error: " + (s.queue[1].error || "").slice(0, 70));
  s = await send({ type: "remove", id: s.queue[1].id });
  s = await send({ type: "remove", id: s.queue[0].id });
  assert(s.queue.length === 0 && log.badge[log.badge.length - 1] === "", "remove empties queue and badge");

  // a restart reloads settings and the queue
  await send({ type: "add", mode: "audio" });
  await sleep(400);
  assert(store.queue.length === 1, "queue saved for next session");
  const left = fs.readdirSync(outDir).filter((f) => f.startsWith(".reaper-tmp"));
  assert(left.length === 0, "no temp folders left behind");
  process.exit();
})();
