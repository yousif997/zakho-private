const { app, BrowserWindow, ipcMain, shell, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");
const crypto = require("crypto");

if (process.env.ZPR_USERDATA) app.setPath("userData", process.env.ZPR_USERDATA);
app.setAppUserModelId("com.lunait.zakhoprivate.records");
if (!app.requestSingleInstanceLock()) { app.quit(); }

let win;
const backupDir = () => path.join(app.getPath("documents"), "Zakho Private Backups");

function stamp(d = new Date()) {
  const p = n => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ---------------- settings (role, pairing) ---------------- */
const cfgFile = () => path.join(app.getPath("userData"), "network.json");
let cfg = {};
function loadCfg() { try { cfg = JSON.parse(fs.readFileSync(cfgFile(), "utf8")) || {}; } catch { cfg = {}; } }
function saveCfg() {
  try { fs.mkdirSync(path.dirname(cfgFile()), { recursive: true }); fs.writeFileSync(cfgFile() + ".tmp", JSON.stringify(cfg, null, 1)); fs.renameSync(cfgFile() + ".tmp", cfgFile()); } catch (e) { console.error(e); }
}
const newCode = () => String(crypto.randomInt(100000, 1000000));
const PORT0 = 47821;

function localIPv4() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) if (a.family === "IPv4" && !a.internal && !a.address.startsWith("169.254.")) out.push({ name, address: a.address, netmask: a.netmask });
  }
  return out;
}

/* ---------------- window ---------------- */
function createWindow() {
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1100, minHeight: 680,
    title: "Zakho Private Records",
    icon: path.join(__dirname, "build", "icon.png"),
    backgroundColor: "#062b2d",
    autoHideMenuBar: true,
    show: false,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, spellcheck: false }
  });
  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, "index.html"));
  win.once("ready-to-show", () => { win.maximize(); win.show(); });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: "deny" }; });
  win.webContents.on("will-navigate", (e, url) => { if (!url.startsWith("file:")) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
  win.webContents.on("before-input-event", (e, input) => {
    if (input.type === "keyDown" && input.control && input.shift && input.key.toLowerCase() === "i") e.preventDefault();
  });
}

app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
app.whenReady().then(() => {
  loadCfg();
  if (cfg.role === "doctor") startServer();
  createWindow();
  setupUpdater();
});
app.on("window-all-closed", () => app.quit());

/* ---------------- backups (unchanged) ---------------- */
ipcMain.handle("backup:auto", async (_e, json) => {
  try {
    const dir = backupDir();
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `backup-${stamp()}.json`);
    fs.writeFileSync(file + ".tmp", json, "utf8");
    fs.renameSync(file + ".tmp", file);
    const files = fs.readdirSync(dir).filter(f => /^backup-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    while (files.length > 60) fs.unlinkSync(path.join(dir, files.shift()));
    return { ok: true, file };
  } catch (err) { return { ok: false, error: String(err) }; }
});
ipcMain.handle("backup:latest", async () => {
  try {
    const dir = backupDir();
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir).filter(f => /^backup-\d{4}-\d{2}-\d{2}\.json$/.test(f)).sort();
    if (!files.length) return null;
    return fs.readFileSync(path.join(dir, files.at(-1)), "utf8");
  } catch { return null; }
});
ipcMain.handle("backup:open", async () => {
  fs.mkdirSync(backupDir(), { recursive: true });
  await shell.openPath(backupDir());
  return true;
});
ipcMain.handle("app:version", () => app.getVersion());
ipcMain.handle("app:flash", () => { if (win && !win.isFocused()) win.flashFrame(true); return true; });

/* ---------------- role ---------------- */
ipcMain.handle("cfg:get", () => ({
  role: cfg.role || null,
  doctor: cfg.doctor || null,
  secName: cfg.secName || "",
  paired: !!(cfg.role === "secretary" && cfg.token && cfg.doctor)
}));
ipcMain.handle("cfg:setRole", (_e, role) => {
  if (role !== "doctor" && role !== "secretary") return false;
  cfg.role = role;
  if (role === "doctor") { cfg.doctorId = cfg.doctorId || crypto.randomUUID(); cfg.pairCode = cfg.pairCode || newCode(); cfg.secretaries = cfg.secretaries || []; }
  saveCfg();
  if (role === "doctor") startServer();
  return true;
});

/* =========================================================
   DOCTOR SIDE — small HTTP server on the hospital network.
   The secretary's computer talks to it; every request after
   pairing must carry the secretary's token.
   ========================================================= */
let server = null, serverPort = null, profile = { name: "", specialty: "" };
const pending = new Map(); // rid -> resolve
const failed = new Map();  // ip -> [timestamps] wrong pair codes

ipcMain.handle("lan:profile", (_e, p) => { profile = { name: String(p?.name || ""), specialty: String(p?.specialty || "") }; return true; });
ipcMain.handle("rpc:res", (_e, rid, res) => { const r = pending.get(rid); if (r) { pending.delete(rid); r(res); } return true; });
ipcMain.handle("lan:info", () => ({
  code: cfg.pairCode, port: serverPort, running: !!serverPort,
  ips: localIPv4().map(a => a.address),
  secretaries: (cfg.secretaries || []).map(s => ({ id: s.id, name: s.name, paired: s.paired, lastSeen: s.lastSeen || 0 }))
}));
ipcMain.handle("lan:newCode", () => { cfg.pairCode = newCode(); saveCfg(); return cfg.pairCode; });
ipcMain.handle("lan:revoke", (_e, id) => { cfg.secretaries = (cfg.secretaries || []).filter(s => s.id !== id); saveCfg(); return true; });

function askRenderer(method, params, from) {
  return new Promise(resolve => {
    if (!win || win.isDestroyed()) return resolve({ ok: false, error: "closed" });
    const rid = crypto.randomUUID();
    pending.set(rid, resolve);
    win.webContents.send("rpc:req", { rid, method, params, from });
    setTimeout(() => { if (pending.has(rid)) { pending.delete(rid); resolve({ ok: false, error: "timeout" }); } }, 10000);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", c => { size += c.length; if (size > 2e6) { reject(new Error("too big")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {}); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
function send(res, code, obj) {
  const b = Buffer.from(JSON.stringify(obj));
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Content-Length": b.length });
  res.end(b);
}
const sameToken = (a, b) => { try { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); } catch { return false; } };

async function handle(req, res) {
  const url = (req.url || "").split("?")[0];
  const ip = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
  try {
    if (req.method === "GET" && url === "/zpr/hello") {
      return send(res, 200, { zpr: 1, id: cfg.doctorId, name: profile.name, specialty: profile.specialty, version: app.getVersion() });
    }
    if (req.method === "POST" && url === "/zpr/pair") {
      const now = Date.now();
      const tries = (failed.get(ip) || []).filter(t => now - t < 60000);
      if (tries.length >= 5) return send(res, 429, { error: "wait" });
      const body = await readBody(req);
      if (!cfg.pairCode || String(body.code || "").trim() !== cfg.pairCode) {
        tries.push(now); failed.set(ip, tries);
        return send(res, 403, { error: "code" });
      }
      const sec = { id: crypto.randomUUID(), name: String(body.name || "").slice(0, 60) || "Secretary", token: crypto.randomBytes(24).toString("hex"), paired: now, lastSeen: now };
      cfg.secretaries = [...(cfg.secretaries || []), sec];
      cfg.pairCode = newCode(); // a code works only once
      saveCfg();
      if (win && !win.isDestroyed()) win.webContents.send("lan:changed");
      return send(res, 200, { token: sec.token, doctor: { id: cfg.doctorId, name: profile.name, specialty: profile.specialty } });
    }
    if (req.method === "POST" && url === "/zpr/rpc") {
      const tok = req.headers["x-zpr-token"];
      const sec = (cfg.secretaries || []).find(s => sameToken(s.token, tok));
      if (!sec) return send(res, 401, { error: "auth" });
      sec.lastSeen = Date.now();
      const body = await readBody(req);
      const out = await askRenderer(String(body.method || ""), body.params || {}, { id: sec.id, name: sec.name });
      return send(res, 200, out);
    }
    send(res, 404, { error: "not found" });
  } catch (e) { send(res, 400, { error: "bad request" }); }
}

function startServer() {
  if (server) return;
  let port = PORT0;
  const s = http.createServer(handle);
  s.on("error", err => {
    if (err.code === "EADDRINUSE" && port < PORT0 + 5) { port++; setTimeout(() => s.listen(port, "0.0.0.0"), 100); }
    else console.error("server", err);
  });
  s.on("listening", () => { serverPort = port; if (win && !win.isDestroyed()) win.webContents.send("lan:changed"); });
  s.listen(port, "0.0.0.0");
  server = s;
  setInterval(() => saveCfg(), 5 * 60 * 1000); // persist lastSeen now and then
}

/* =========================================================
   SECRETARY SIDE — finds doctors on the network and calls them.
   ========================================================= */
function httpJSON(host, port, method, p, body, token, timeout = 6000) {
  return new Promise((resolve, reject) => {
    const data = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request({ host, port, path: p, method, timeout, headers: { "Content-Type": "application/json", ...(data ? { "Content-Length": data.length } : {}), ...(token ? { "x-zpr-token": token } : {}) } }, res => {
      const chunks = [];
      res.on("data", c => chunks.push(c));
      res.on("end", () => { let j = null; try { j = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {} resolve({ status: res.statusCode, body: j }); });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function hello(host, port) {
  try { const r = await httpJSON(host, port, "GET", "/zpr/hello", null, null, 900); if (r.status === 200 && r.body && r.body.zpr) return { ...r.body, host, port }; } catch {}
  return null;
}

async function scan(extraHost) {
  const hosts = new Set();
  const mine = new Set(localIPv4().map(a => a.address));
  for (const a of localIPv4()) {
    const parts = a.address.split(".");
    for (let i = 1; i < 255; i++) { const h = `${parts[0]}.${parts[1]}.${parts[2]}.${i}`; if (!mine.has(h)) hosts.add(h); }
  }
  if (extraHost) hosts.add(extraHost);
  const list = [...hosts], found = [];
  const ports = [PORT0, PORT0 + 1];
  let idx = 0;
  async function worker() {
    while (idx < list.length) {
      const h = list[idx++];
      for (const p of ports) { const d = await hello(h, p); if (d) { found.push(d); break; } }
    }
  }
  await Promise.all(Array.from({ length: 96 }, worker));
  const uniq = new Map();
  for (const d of found) if (!uniq.has(d.id)) uniq.set(d.id, d);
  return [...uniq.values()].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

ipcMain.handle("lan:scan", async (_e, extra) => {
  let host = null, port = PORT0;
  if (extra) { const m = String(extra).trim().match(/^([\w.-]+)(?::(\d+))?$/); if (m) { host = m[1]; if (m[2]) port = +m[2]; } }
  if (host && port !== PORT0) { const d = await hello(host, port); return d ? [d] : []; }
  return scan(host);
});

ipcMain.handle("lan:pair", async (_e, { host, port, code, name }) => {
  try {
    const r = await httpJSON(host, port || PORT0, "POST", "/zpr/pair", { code, name });
    if (r.status === 200 && r.body && r.body.token) {
      cfg.role = "secretary"; cfg.secName = name; cfg.token = r.body.token;
      cfg.doctor = { ...r.body.doctor, host, port: port || PORT0 };
      saveCfg();
      return { ok: true, doctor: cfg.doctor };
    }
    return { ok: false, error: r.status === 429 ? "wait" : r.status === 403 ? "code" : "fail" };
  } catch { return { ok: false, error: "offline" }; }
});
ipcMain.handle("lan:disconnect", () => { delete cfg.token; delete cfg.doctor; saveCfg(); return true; });

let relocating = null;
async function relocate() {
  // the doctor's computer may have a new address (DHCP) — look for the same doctor id again
  if (!relocating) relocating = (async () => {
    const list = await scan();
    const d = list.find(x => x.id === cfg.doctor?.id);
    if (d) { cfg.doctor = { ...cfg.doctor, host: d.host, port: d.port, name: d.name || cfg.doctor.name, specialty: d.specialty }; saveCfg(); return true; }
    return false;
  })().finally(() => setTimeout(() => { relocating = null; }, 30000));
  return relocating;
}

ipcMain.handle("lan:call", async (_e, method, params) => {
  if (!cfg.token || !cfg.doctor) return { ok: false, error: "unpaired" };
  const once = () => httpJSON(cfg.doctor.host, cfg.doctor.port, "POST", "/zpr/rpc", { method, params }, cfg.token);
  try {
    const r = await once();
    if (r.status === 401) return { ok: false, error: "unpaired" };
    return r.body || { ok: false, error: "fail" };
  } catch {
    if (await relocate()) { try { const r = await once(); if (r.status === 401) return { ok: false, error: "unpaired" }; return r.body || { ok: false, error: "fail" }; } catch {} }
    return { ok: false, error: "offline" };
  }
});

/* =========================================================
   AUTOMATIC UPDATES — checks GitHub for a newer version,
   downloads it in the background and installs on restart.
   ========================================================= */
let updateReady = null;
function setupUpdater() {
  if (!app.isPackaged) return;
  let autoUpdater;
  try { ({ autoUpdater } = require("electron-updater")); } catch (e) { console.error(e); return; }
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on("update-downloaded", info => {
    updateReady = info.version;
    if (win && !win.isDestroyed()) win.webContents.send("update:ready", info.version);
  });
  autoUpdater.on("error", e => console.error("update", e && e.message));
  const check = () => autoUpdater.checkForUpdates().catch(() => {});
  setTimeout(check, 8000);
  setInterval(check, 3 * 60 * 60 * 1000);
  ipcMain.handle("update:install", () => { autoUpdater.quitAndInstall(true, true); return true; });
}
ipcMain.handle("update:status", () => updateReady);
