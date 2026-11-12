// Usage: node hosttest.js <host-binary> '<json message>' ...  — prints every reply.
const { spawn } = require("child_process");
const [bin, ...msgs] = process.argv.slice(2);
const p = spawn(bin, ["/x/reaper_host.json", "reaper@localhost"], { stdio: ["pipe", "pipe", "inherit"] });
const sendMsg = (o) => { const b = Buffer.from(JSON.stringify(o)); const h = Buffer.alloc(4); h.writeUInt32LE(b.length); p.stdin.write(Buffer.concat([h, b])); };
let buf = Buffer.alloc(0), pending = 0, seen = new Set();
p.stdout.on("data", (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
    const n = buf.readUInt32LE(0); const m = JSON.parse(buf.slice(4, 4 + n)); buf = buf.slice(4 + n);
    if (m.type === "progress") { const k = m.id + m.stage + Math.floor(m.percent / 50); if (seen.has(k)) continue; seen.add(k); }
    console.log(JSON.stringify(m));
    if (["done", "error", "cancelled", "hello"].includes(m.type)) { if (--pending <= 0) p.stdin.end(); }
  }
});
for (const s of msgs) {
  const m = JSON.parse(s);
  if (m.delay) { setTimeout(() => sendMsg(m), m.delay); continue; }
  if (["download", "hello"].includes(m.type)) pending++;
  sendMsg(m);
}
