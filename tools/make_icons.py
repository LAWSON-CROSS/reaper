import json, subprocess, sys
from PIL import Image
root = sys.argv[1]
js = """
const s=require(process.argv[1]);const out={idle:{},frames:[]};
for(const z of [16,32,48,96,128]) out.idle[z]=Array.from(s.idle(z));
for(let i=0;i<s.frameCount;i++) out.frames.push(Array.from(s.frame(i,64)));
console.log(JSON.stringify(out));
"""
d = json.loads(subprocess.check_output(["node", "-e", js, root + "/extension/sprite.js"]))
for z, px in d["idle"].items():
    z = int(z); Image.frombytes("RGBA", (z, z), bytes(px)).save(f"{root}/extension/icons/scythe-{z}.png")
# contact sheet for preview
fr = d["frames"]; sheet = Image.new("RGBA", (64 * 6 * 2, 64 * 2 * 2), (40, 40, 48, 255))
for i, px in enumerate(fr):
    im = Image.frombytes("RGBA", (64, 64), bytes(px)).resize((128, 128), Image.NEAREST)
    sheet.paste(im, ((i % 6) * 128, (i // 6) * 128), im)
sheet.save(sys.argv[2] + "/sheet.png")
big = Image.frombytes("RGBA", (128, 128), bytes(d["idle"]["128"])).resize((384, 384), Image.NEAREST)
bg = Image.new("RGBA", (384, 384), (40, 40, 48, 255)); bg.paste(big, (0, 0), big); bg.save(sys.argv[2] + "/idle.png")
gif = [Image.frombytes("RGBA", (64, 64), bytes(px)).resize((192, 192), Image.NEAREST) for px in fr]
gif[0].save(sys.argv[2] + "/slash.gif", save_all=True, append_images=gif[1:], duration=70, loop=0, disposal=2)
