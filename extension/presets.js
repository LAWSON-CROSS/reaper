// Shared between the background page and the popup.
(function (root) {
  const VIDEO_PRESETS = [
    { id: "src-mp4", name: "Source quality · MP4", speed: "fast", container: "mp4", vcodec: "copy", resolution: 0, vbitrate: 0 },
    { id: "src-mkv", name: "Source quality · MKV", speed: "fast", container: "mkv", vcodec: "copy", resolution: 0, vbitrate: 0 },
    { id: "h264-1080", name: "H.264 · MP4 · 1080p", speed: "fast", container: "mp4", vcodec: "h264", resolution: 1080, vbitrate: 0 },
    { id: "h264-1440", name: "H.264 · MP4 · 1440p", speed: "slow", container: "mp4", vcodec: "h264", resolution: 1440, vbitrate: 0 },
    { id: "h264-2160", name: "H.264 · MP4 · 4K", speed: "slow", container: "mp4", vcodec: "h264", resolution: 2160, vbitrate: 0 },
    { id: "h265-2160", name: "H.265 (HEVC) · MP4 · 4K", speed: "slow", container: "mp4", vcodec: "h265", resolution: 2160, vbitrate: 0 },
    { id: "qt-h264-2160", name: "QuickTime H.264 · MOV · 4K", speed: "slow", container: "mov", vcodec: "h264", resolution: 2160, vbitrate: 0 },
    { id: "prores-1080", name: "QuickTime ProRes 422 · MOV · 1080p", speed: "slow", container: "mov", vcodec: "prores_422", resolution: 1080, vbitrate: 0 },
    { id: "prores-2160", name: "QuickTime ProRes 422 · MOV · 4K", speed: "slow", container: "mov", vcodec: "prores_422", resolution: 2160, vbitrate: 0 },
    { id: "proreshq-2160", name: "QuickTime ProRes 422 HQ · MOV · 4K", speed: "slow", container: "mov", vcodec: "prores_hq", resolution: 2160, vbitrate: 0 },
    { id: "dnxhr-2160", name: "DNxHR HQ · MOV · 4K", speed: "slow", container: "mov", vcodec: "dnxhr_hq", resolution: 2160, vbitrate: 0 },
    { id: "vp9-webm", name: "VP9 · WebM · 4K", speed: "fast", container: "webm", vcodec: "vp9", resolution: 2160, vbitrate: 0 },
  ];
  const AUDIO_PRESETS = [
    { id: "mp3-320", name: "MP3 · 320 kbps", acodec: "mp3", abitrate: 320 },
    { id: "mp3-192", name: "MP3 · 192 kbps", acodec: "mp3", abitrate: 192 },
    { id: "aac-256", name: "AAC (M4A) · 256 kbps", acodec: "aac", abitrate: 256 },
    { id: "wav", name: "WAV · uncompressed", acodec: "wav", abitrate: 0 },
    { id: "flac", name: "FLAC · lossless", acodec: "flac", abitrate: 0 },
    { id: "opus-160", name: "Opus · 160 kbps", acodec: "opus", abitrate: 160 },
    { id: "source", name: "Source audio · no re-encode", acodec: "source", abitrate: 0 },
  ];
  const VCODECS = {
    copy: { name: "Source (no re-encode)", short: "Source", containers: ["mp4", "mkv"], bitrate: false },
    h264: { name: "H.264 (AVC)", short: "H.264", containers: ["mp4", "mov", "mkv"], bitrate: true },
    h265: { name: "H.265 (HEVC)", short: "H.265", containers: ["mp4", "mov", "mkv"], bitrate: true },
    prores_proxy: { name: "ProRes 422 Proxy", short: "ProRes Proxy", containers: ["mov"], bitrate: false },
    prores_lt: { name: "ProRes 422 LT", short: "ProRes LT", containers: ["mov"], bitrate: false },
    prores_422: { name: "ProRes 422", short: "ProRes 422", containers: ["mov"], bitrate: false },
    prores_hq: { name: "ProRes 422 HQ", short: "ProRes HQ", containers: ["mov"], bitrate: false },
    dnxhr_sq: { name: "DNxHR SQ", short: "DNxHR SQ", containers: ["mov"], bitrate: false },
    dnxhr_hq: { name: "DNxHR HQ", short: "DNxHR HQ", containers: ["mov"], bitrate: false },
    vp9: { name: "VP9", short: "VP9", containers: ["webm", "mkv", "mp4"], bitrate: true },
    av1: { name: "AV1", short: "AV1", containers: ["mp4", "mkv", "webm"], bitrate: true },
  };
  const CONTAINERS = { mp4: "MP4", mov: "QuickTime (MOV)", mkv: "Matroska (MKV)", webm: "WebM" };
  const RESOLUTIONS = [[0, "Best available"], [4320, "8K (4320p)"], [2160, "4K (2160p)"], [1440, "1440p"], [1080, "1080p"], [720, "720p"], [480, "480p"], [360, "360p"]];
  const VBITRATES = [[0, "Auto (quality-based)"], [5000, "5 Mbps"], [8000, "8 Mbps"], [12000, "12 Mbps"], [16000, "16 Mbps"], [24000, "24 Mbps"], [35000, "35 Mbps"], [45000, "45 Mbps"], [68000, "68 Mbps"], [100000, "100 Mbps"]];
  const ACODECS = {
    mp3: { name: "MP3", bitrate: true }, aac: { name: "AAC (M4A)", bitrate: true }, opus: { name: "Opus", bitrate: true },
    wav: { name: "WAV", bitrate: false }, flac: { name: "FLAC", bitrate: false }, alac: { name: "Apple Lossless (ALAC)", bitrate: false },
    source: { name: "Source (no re-encode)", bitrate: false },
  };
  const ABITRATES = [96, 128, 160, 192, 256, 320];

  const DEFAULTS = {
    outDir: "",
    video: { preset: "h264-1080", container: "mp4", vcodec: "h264", resolution: 1080, vbitrate: 0 },
    audio: { preset: "mp3-320", acodec: "mp3", abitrate: 320 },
    concurrency: 2,
    gpu: false,
    cookies: false,
    autoStart: false,
  };

  function resLabel(r) { return r === 0 ? "best" : r === 2160 ? "4K" : r === 4320 ? "8K" : r + "p"; }
  function videoLabel(v) {
    const ext = v.container.toUpperCase();
    return `${VCODECS[v.vcodec].short} ${resLabel(v.resolution)} · ${ext}`;
  }
  function audioLabel(a) {
    const c = ACODECS[a.acodec];
    return a.acodec === "source" ? "Source audio" : c.name.replace(" (M4A)", "") + (c.bitrate ? " " + a.abitrate : "");
  }
  function matchPreset(list, obj, keys) {
    const p = list.find((p) => keys.every((k) => p[k] === obj[k]));
    return p ? p.id : "custom";
  }
  const videoPresetOf = (v) => matchPreset(VIDEO_PRESETS, v, ["container", "vcodec", "resolution", "vbitrate"]);
  const audioPresetOf = (a) => matchPreset(AUDIO_PRESETS, a, ACODECS[a.acodec].bitrate ? ["acodec", "abitrate"] : ["acodec"]);

  // Returns {site, url, audioOnly} for pages we can reap, or null.
  function site(raw) {
    let u;
    try { u = new URL(raw); } catch (e) { return null; }
    const h = u.hostname.replace(/^(www|m|music)\./, "");
    if (h === "youtube.com") {
      if (u.pathname === "/watch" && u.searchParams.get("v")) {
        const host = u.hostname.startsWith("music.") ? "music.youtube.com" : "www.youtube.com";
        return { site: "youtube", url: `https://${host}/watch?v=${u.searchParams.get("v")}`, audioOnly: false };
      }
      const m = u.pathname.match(/^\/(shorts|live|embed)\/([\w-]{6,})/);
      if (m) return { site: "youtube", url: `https://www.youtube.com/watch?v=${m[2]}`, audioOnly: false };
      return null;
    }
    if (h === "youtu.be" && u.pathname.length > 6) return { site: "youtube", url: `https://www.youtube.com/watch?v=${u.pathname.slice(1)}`, audioOnly: false };
    if (h === "soundcloud.com") {
      const parts = u.pathname.split("/").filter(Boolean);
      const reserved = ["discover", "feed", "you", "search", "stream", "upload", "settings", "messages", "notifications", "charts", "pages"];
      if (parts.length >= 2 && !reserved.includes(parts[0]) && !["sets", "tracks", "albums", "likes", "reposts", "followers", "following", "popular-tracks", "toptracks"].includes(parts[1]))
        return { site: "soundcloud", url: `https://soundcloud.com/${parts.slice(0, /^s-/.test(parts[2] || "") ? 3 : 2).join("/")}${u.searchParams.get("secret_token") ? "?secret_token=" + u.searchParams.get("secret_token") : ""}`, audioOnly: true };
      return null;
    }
    return null;
  }
  function cleanTitle(t) {
    return (t || "")
      .replace(/^\(\d+\+?\)\s*/, "")
      .replace(/\s+-\s+YouTube( Music)?$/, "")
      .replace(/^Stream\s+/, "")
      .replace(/\s*\|\s*Listen online for free on SoundCloud$/, "")
      .trim() || "Untitled";
  }

  // Where the helper app lives. Filled in at release time.
  const REPO_URL = "https://github.com/LAWSON-CROSS/reaper";
  const HELPER_URL = REPO_URL + "#install";

  root.REAPER = { REPO_URL, HELPER_URL, VIDEO_PRESETS, AUDIO_PRESETS, VCODECS, CONTAINERS, RESOLUTIONS, VBITRATES, ACODECS, ABITRATES, DEFAULTS, videoLabel, audioLabel, videoPresetOf, audioPresetOf, site, cleanTitle };
})(typeof self !== "undefined" ? self : globalThis);
