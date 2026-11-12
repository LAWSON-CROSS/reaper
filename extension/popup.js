"use strict";
const R = self.REAPER;
const $ = (id) => document.getElementById(id);
let state = null, tabInfo = null, tabCount = 0;
const isTab = location.hash === "#settings";

// ---------- talking to the background page ----------
async function call(type, extra) {
  const res = await browser.runtime.sendMessage({ type, ...extra });
  if (res) apply(res);
}
function apply(res) {
  if ("tab" in res) { tabInfo = res.tab; tabCount = res.tabCount; }
  state = res;
  if (res.notice) toast(res.notice);
  render();
}
browser.runtime.onMessage.addListener((m) => { if (m && m.type === "state") apply(m.state); });

let toastTimer;
function toast(text) {
  const t = $("toast");
  t.textContent = text; t.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
}

function helperLink(text) {
  const a = document.createElement("a");
  a.href = R.HELPER_URL; a.textContent = text;
  a.addEventListener("click", (e) => { e.preventDefault(); browser.tabs.create({ url: R.HELPER_URL }); window.close(); });
  return a;
}

// ---------- main view ----------
function render() {
  if (!state) return;
  const s = state.settings, q = state.queue;
  const site = tabInfo && tabInfo.site;

  // helper warning
  const w = $("hostwarn");
  const h = state.host;
  if (h.status === "missing") {
    w.hidden = false;
    w.textContent = "Reaper needs its free helper app to download and convert files. Install it once, then reopen this panel. ";
    w.appendChild(helperLink("Get the helper app"));
  } else if (h.status === "ok" && (!h.ytdlp || !h.ffmpeg)) {
    w.hidden = false;
    w.textContent = `The helper is missing ${!h.ytdlp ? "yt-dlp" : "ffmpeg"}. Run its setup again to repair it. `;
    w.appendChild(helperLink("Setup instructions"));
  } else w.hidden = true;

  // current tab + mode buttons
  const tt = $("tabtitle");
  tt.textContent = site ? tabInfo.title : "Open a YouTube video or SoundCloud track to queue it.";
  tt.classList.toggle("on", !!site);
  $("lblAudio").textContent = R.audioLabel(s.audio);
  $("lblVideo").textContent = R.videoLabel(s.video) + " · silent";
  $("lblBoth").textContent = R.videoLabel(s.video) + " + audio";
  for (const b of document.querySelectorAll(".mode")) {
    const audioOnly = site && site.audioOnly && b.dataset.mode !== "audio";
    b.disabled = !site || audioOnly;
    b.title = audioOnly ? "SoundCloud is audio only" : "";
  }
  $("alltabs").hidden = tabCount < 2;
  $("alltabsLabel").textContent = `Queue all ${tabCount} open tabs as`;

  // queue
  const pending = q.filter((j) => j.status === "queued").length;
  const active = q.filter((j) => j.status === "active").length;
  const finished = q.length - pending - active;
  $("qtitle").textContent = q.length ? `Queue · ${pending + active} to go` : "Queue";
  $("clearDone").hidden = !finished;
  $("empty").hidden = q.length > 0;
  const ul = $("queue");
  const seen = new Set();
  for (const j of q) {
    seen.add(j.id);
    let li = ul.querySelector(`li[data-id="${j.id}"]`);
    if (!li) {
      li = document.createElement("li");
      li.dataset.id = j.id;
      li.innerHTML = `<div class="t"></div><div class="acts"><button data-act="retry" title="Try again">↻</button><button data-act="remove" title="Remove">✕</button></div><div class="s"></div><div class="bar"></div>`;
      ul.appendChild(li);
    }
    li.className = `${j.mode} ${j.status}`;
    li.querySelector(".t").textContent = j.title;
    li.querySelector(".t").title = j.title;
    const kind = j.mode[0].toUpperCase() + j.mode.slice(1);
    let sub = `${kind} · ${j.label}`;
    if (j.status === "active") sub = `${j.stage || "Starting"} ${j.percent ? Math.round(j.percent) + "%" : ""}${j.detail ? " · " + j.detail : ""}`;
    if (j.status === "done") sub = `Done · ${j.label}`;
    if (j.status === "error") sub = j.error || "Failed";
    li.querySelector(".s").textContent = sub;
    li.querySelector(".bar").style.width = j.status === "active" ? Math.max(2, j.percent) + "%" : "0";
    li.querySelector('[data-act="retry"]').hidden = j.status !== "error";
  }
  for (const li of [...ul.children]) if (!seen.has(li.dataset.id)) li.remove();

  // start / stop
  const st = $("start");
  if (state.running || active) {
    st.textContent = `Stop  (${pending + active} left)`;
    st.classList.add("stop"); st.disabled = false; st.dataset.act = "stop";
  } else {
    st.textContent = pending ? `Start ${pending} download${pending === 1 ? "" : "s"}` : "Start";
    st.classList.remove("stop"); st.disabled = !pending || h.status === "missing"; st.dataset.act = "start";
  }
  if (!settingsDirty) renderSettings();
}

document.querySelectorAll(".mode").forEach((b) => b.addEventListener("click", () => call("add", { mode: b.dataset.mode })));
document.querySelectorAll("[data-all]").forEach((b) => b.addEventListener("click", () => call("addAll", { mode: b.dataset.all })));
$("queue").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-act]");
  if (b) call(b.dataset.act, { id: b.closest("li").dataset.id });
});
$("clearDone").addEventListener("click", () => call("clearDone"));
$("start").addEventListener("click", () => call($("start").dataset.act));
$("folder").addEventListener("click", () => call("openFolder"));
$("gear").addEventListener("click", () => show($("settings").hidden ? "settings" : "main"));
$("back").addEventListener("click", () => show("main"));
function show(view) {
  $("main").hidden = view !== "main";
  $("settings").hidden = view !== "settings";
  $("back").hidden = isTab;
}

// ---------- settings view ----------
let settingsDirty = false;
function fill(sel, pairs, value) {
  const want = pairs.map((p) => p[0] + "\u0000" + p[1]).join("\u0001");
  if (sel.dataset.sig !== want) {
    sel.dataset.sig = want;
    sel.textContent = "";
    for (const [v, label] of pairs) sel.add(new Option(label, v));
  }
  sel.value = String(value);
}
function renderSettings() {
  const s = state.settings, v = s.video, a = s.audio, h = state.host;
  if (document.activeElement !== $("outDir")) $("outDir").value = s.outDir;
  $("outDir").placeholder = h.defaultDir || "Your Downloads folder";
  $("browse").disabled = h.status !== "ok";

  const vp = R.videoPresetOf(v);
  fill($("vPreset"), [...R.VIDEO_PRESETS.map((p) => [p.id, `${p.name}${p.speed === "slow" ? "  — re-encodes" : ""}`]), ...(vp === "custom" ? [["custom", "Custom"]] : [])], vp);
  fill($("vCodec"), Object.entries(R.VCODECS).map(([k, c]) => [k, c.name]), v.vcodec);
  fill($("vContainer"), R.VCODECS[v.vcodec].containers.map((c) => [c, R.CONTAINERS[c]]), v.container);
  fill($("vRes"), R.RESOLUTIONS, v.resolution);
  fill($("vBitrate"), R.VCODECS[v.vcodec].bitrate ? R.VBITRATES : [[0, v.vcodec === "copy" ? "Same as source" : "Set by codec"]], R.VCODECS[v.vcodec].bitrate ? v.vbitrate : 0);
  $("vBitrate").disabled = !R.VCODECS[v.vcodec].bitrate;
  $("vHint").textContent =
    v.vcodec === "copy" ? "Fastest: keeps YouTube's own stream untouched. Above 1080p that stream is VP9 or AV1."
    : /^(prores|dnxhr)/.test(v.vcodec) ? "Edit-ready for Resolve and Premiere. Files are very large (roughly 1 GB per minute at 4K) and take a while to convert."
    : v.vcodec === "h264" && v.resolution > 0 && v.resolution <= 1080 && !v.vbitrate ? "YouTube already serves H.264 at this size, so this is usually instant with no re-encode."
    : "YouTube usually has to be converted for this, so expect it to take longer than the download itself.";

  const ap = R.audioPresetOf(a);
  fill($("aPreset"), [...R.AUDIO_PRESETS.map((p) => [p.id, p.name]), ...(ap === "custom" ? [["custom", "Custom"]] : [])], ap);
  fill($("aCodec"), Object.entries(R.ACODECS).map(([k, c]) => [k, c.name]), a.acodec);
  const ab = R.ACODECS[a.acodec].bitrate;
  fill($("aBitrate"), ab ? R.ABITRATES.map((b) => [b, b + " kbps"]) : [[0, a.acodec === "source" ? "Same as source" : "Lossless"]], ab ? a.abitrate : 0);
  $("aBitrate").disabled = !ab;
  $("aHint").textContent =
    a.acodec === "wav" || a.acodec === "flac" || a.acodec === "alac" ? "Handy for editing, but the source is already compressed, so this won't add quality."
    : "";

  $("concurrency").value = String(s.concurrency);
  $("autoStart").checked = s.autoStart; $("gpu").checked = s.gpu; $("cookies").checked = s.cookies;

  const hi = $("hostInfo");
  hi.classList.toggle("bad", h.status === "missing");
  hi.textContent = h.status === "ok"
    ? `Connected · yt-dlp ${h.ytdlp || "missing"} · ffmpeg ${h.ffmpeg ? "ready" : "missing"}${h.deno ? "" : " · deno missing"}`
    : h.status === "missing" ? "Not installed. Use the link on the main panel." : "Checking…";
  $("update").disabled = h.status !== "ok" || h.updating;
  $("update").textContent = h.updating ? "Updating…" : "Update yt-dlp";
}

async function saveSettings(mutate) {
  const s = JSON.parse(JSON.stringify(state.settings));
  mutate(s);
  // keep codec / container / bitrate combinations valid
  const vc = R.VCODECS[s.video.vcodec];
  if (!vc.containers.includes(s.video.container)) s.video.container = vc.containers[0];
  if (!vc.bitrate) s.video.vbitrate = 0;
  if (R.ACODECS[s.audio.acodec].bitrate) { if (!R.ABITRATES.includes(s.audio.abitrate)) s.audio.abitrate = s.audio.acodec === "opus" ? 160 : 256; }
  else s.audio.abitrate = 0;
  s.video.preset = R.videoPresetOf(s.video);
  s.audio.preset = R.audioPresetOf(s.audio);
  settingsDirty = false;
  await call("settings", { settings: s });
  const sv = $("saved"); sv.classList.add("show"); setTimeout(() => sv.classList.remove("show"), 1200);
}
const num = (el) => parseInt(el.value, 10) || 0;
$("vPreset").addEventListener("change", (e) => { const p = R.VIDEO_PRESETS.find((p) => p.id === e.target.value); if (p) saveSettings((s) => Object.assign(s.video, { container: p.container, vcodec: p.vcodec, resolution: p.resolution, vbitrate: p.vbitrate })); });
$("vCodec").addEventListener("change", (e) => saveSettings((s) => { s.video.vcodec = e.target.value; }));
$("vContainer").addEventListener("change", (e) => saveSettings((s) => { s.video.container = e.target.value; }));
$("vRes").addEventListener("change", (e) => saveSettings((s) => { s.video.resolution = num(e.target); }));
$("vBitrate").addEventListener("change", (e) => saveSettings((s) => { s.video.vbitrate = num(e.target); }));
$("aPreset").addEventListener("change", (e) => { const p = R.AUDIO_PRESETS.find((p) => p.id === e.target.value); if (p) saveSettings((s) => Object.assign(s.audio, { acodec: p.acodec, abitrate: p.abitrate })); });
$("aCodec").addEventListener("change", (e) => saveSettings((s) => { s.audio.acodec = e.target.value; }));
$("aBitrate").addEventListener("change", (e) => saveSettings((s) => { s.audio.abitrate = num(e.target); }));
$("concurrency").addEventListener("change", (e) => saveSettings((s) => { s.concurrency = num(e.target); }));
for (const k of ["autoStart", "gpu", "cookies"]) $(k).addEventListener("change", (e) => saveSettings((s) => { s[k] = e.target.checked; }));
$("outDir").addEventListener("input", () => { settingsDirty = true; });
$("outDir").addEventListener("change", (e) => saveSettings((s) => { s.outDir = e.target.value.trim().replace(/^"(.*)"$/, "$1"); }));
$("browse").addEventListener("click", () => call("pickFolder"));
$("update").addEventListener("click", () => call("update"));

// ---------- boot ----------
const lg = $("logo").getContext("2d");
lg.putImageData(new ImageData(ScytheSprite.idle(32), 32, 32), 0, 0);
if (isTab) document.body.classList.add("tab");
show(isTab ? "settings" : "main");
call("open");
