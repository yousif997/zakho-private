const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("desktop", {
  autoBackup: json => ipcRenderer.invoke("backup:auto", json),
  latestBackup: () => ipcRenderer.invoke("backup:latest"),
  openBackups: () => ipcRenderer.invoke("backup:open"),
  version: () => ipcRenderer.invoke("app:version"),
  flash: () => ipcRenderer.invoke("app:flash"),
  // role
  cfg: () => ipcRenderer.invoke("cfg:get"),
  setRole: role => ipcRenderer.invoke("cfg:setRole", role),
  // doctor side
  setProfile: p => ipcRenderer.invoke("lan:profile", p),
  lanInfo: () => ipcRenderer.invoke("lan:info"),
  newCode: () => ipcRenderer.invoke("lan:newCode"),
  revoke: id => ipcRenderer.invoke("lan:revoke", id),
  onRequest: fn => ipcRenderer.on("rpc:req", async (_e, req) => {
    let res;
    try { res = { ok: true, data: await fn(req.method, req.params || {}, req.from || {}) }; }
    catch (err) { res = { ok: false, error: String(err && err.message || err) }; }
    ipcRenderer.invoke("rpc:res", req.rid, res);
  }),
  onLanChanged: fn => ipcRenderer.on("lan:changed", () => fn()),
  // secretary side
  scan: extra => ipcRenderer.invoke("lan:scan", extra),
  pair: o => ipcRenderer.invoke("lan:pair", o),
  disconnect: () => ipcRenderer.invoke("lan:disconnect"),
  call: (method, params) => ipcRenderer.invoke("lan:call", method, params),
  // updates
  onUpdate: fn => ipcRenderer.on("update:ready", (_e, v) => fn(v)),
  updateStatus: () => ipcRenderer.invoke("update:status"),
  installUpdate: () => ipcRenderer.invoke("update:install")
});
