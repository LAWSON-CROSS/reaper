const { chromium } = require("playwright");
const path = require("path");
const out = process.argv[2];
(async () => {
  const b = await chromium.launch();
  const mock = (hostStatus) => `
    const V={preset:"prores-2160",container:"mov",vcodec:"prores_422",resolution:2160,vbitrate:0}, A={preset:"mp3-320",acodec:"mp3",abitrate:320};
    let st={settings:{outDir:"D:\\\\Footage\\\\Rips",video:V,audio:A,concurrency:2,gpu:true,cookies:false,autoStart:false},running:${hostStatus === "ok"},
      host:${hostStatus === "ok" ? `{status:"ok",ytdlp:"2026.10.26",ffmpeg:true,deno:true,defaultDir:"C:\\\\Users\\\\Lawson\\\\Downloads"}` : `{status:"missing"}`},
      queue:${hostStatus === "ok" ? `[
       {id:"1",title:"Houdini Pyro Breakdown: Full Shot Walkthrough and Compositing Notes",mode:"both",status:"active",stage:"Converting to ProRes",percent:42,detail:"1.8x speed",label:"ProRes 422 4K · MOV + audio"},
       {id:"2",title:"Ambient Texture Pack 04",mode:"audio",status:"active",stage:"Downloading",percent:77,detail:"6.2MiB/s · 00:03 left",label:"MP3 320"},
       {id:"3",title:"Octane Lighting Tips",mode:"video",status:"queued",label:"ProRes 422 4K · MOV · silent"},
       {id:"4",title:"Lo-fi Loop by somebody",mode:"audio",status:"done",label:"MP3 320"},
       {id:"5",title:"Private video",mode:"both",status:"error",error:"Video unavailable. This video is private",label:"x"}]` : `[{id:"3",title:"Octane Lighting Tips",mode:"video",status:"queued",label:"H.264 1080p · MP4 · silent"}]`}};
    window.browser={runtime:{onMessage:{addListener(){}},sendMessage:async(m)=>{ if(m.type==="settings") st.settings=m.settings; return {...st,tab:{title:"Octane Lighting Tips",site:{site:"youtube",audioOnly:false}},tabCount:3}; }}};`;
  for (const [name, hash, status, click] of [["main", "", "ok"], ["missing", "", "missing"], ["settings", "", "ok", "#gear"], ["options-tab", "#settings", "ok"]]) {
    const pg = await b.newPage({ viewport: { width: hash ? 900 : 384, height: 600 }, deviceScaleFactor: 1 });
    pg.on("pageerror", (e) => console.log("PAGE ERROR", name, e.message));
    await pg.addInitScript(mock(status));
    await pg.goto("file://" + path.resolve(__dirname, "../extension/popup.html") + hash);
    if (click) await pg.click(click);
    if (name === "settings") { await pg.selectOption("#vCodec", "h265"); await pg.selectOption("#aCodec", "wav"); }
    await pg.waitForTimeout(200);
    await pg.screenshot({ path: `${out}/ui-${name}.png`, fullPage: true });
    if (name === "settings") console.log("after codec change:", await pg.evaluate(() => [vPreset.value, vContainer.value, [...vContainer.options].map(o => o.value).join("/"), vBitrate.disabled, aPreset.value, aBitrate.disabled].join(" | ")));
    await pg.close();
  }
  await b.close();
})();
