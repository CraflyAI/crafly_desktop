import { app, BrowserWindow, dialog, ipcMain, shell, screen } from "electron";
import * as path from "node:path";
import * as fs from "node:fs/promises";
import * as fssync from "node:fs";
import * as http from "node:http";
import { fork, ChildProcess } from "node:child_process";

type LoadedJobSummary = {
  path: string;
  size: number;
  raw: unknown;
};

let mainWindow: BrowserWindow | null = null;
let progressWindow: BrowserWindow | null = null;
let bridgeServer: http.Server | null = null;
let activeRenderWorker: ChildProcess | null = null;
let latestRenderProgress: { progress: number; phase: string; message: string } | null = null;
const BRIDGE_PORT = 48231;

// 브릿지 서버 CORS 허용 Origin 목록
const ALLOWED_ORIGINS = new Set([
  "https://crafly.kr",
  "https://www.crafly.kr",
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

function isAllowedOrigin(origin: string | undefined): boolean {
  if (!origin) return true; // 브라우저가 아닌 직접 요청 (curl 등)
  return ALLOWED_ORIGINS.has(origin);
}

function getCorsHeaders(origin: string | undefined): Record<string, string> {
  const allowedOrigin = origin && ALLOWED_ORIGINS.has(origin) ? origin : "";
  return {
    "Access-Control-Allow-Origin": allowedOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin",
  };
}

const PREFERENCES_FILE = "preferences.json";

function getPreferencesPath(): string {
  return path.join(app.getPath("userData"), PREFERENCES_FILE);
}

type Preferences = { outputDir?: string };

function loadPreferencesSync(): Preferences {
  try {
    const p = getPreferencesPath();
    if (fssync.existsSync(p)) {
      const raw = fssync.readFileSync(p, "utf8");
      const parsed = JSON.parse(raw) as Preferences;
      if (parsed && typeof parsed === "object") return parsed;
    }
  } catch {
    // ignore
  }
  return {};
}

async function savePreferences(prefs: Preferences): Promise<void> {
  const p = getPreferencesPath();
  await fs.writeFile(p, JSON.stringify(prefs, null, 2), "utf8");
}

function getDefaultOutputDir(): string {
  const prefs = loadPreferencesSync();
  if (prefs.outputDir && typeof prefs.outputDir === "string" && prefs.outputDir.trim().length > 0) {
    return prefs.outputDir.trim();
  }
  return path.join(app.getPath("videos"), "Crafly");
}

async function ensureDefaultOutputDir() {
  await fs.mkdir(getDefaultOutputDir(), { recursive: true });
}

function getJobStorageDir() {
  return path.join(app.getPath("userData"), "jobs");
}

async function ensureJobStorageDir() {
  await fs.mkdir(getJobStorageDir(), { recursive: true });
}

function getAssetCacheDir() {
  return path.join(app.getPath("userData"), "asset-cache");
}

async function ensureAssetCacheDir() {
  await fs.mkdir(getAssetCacheDir(), { recursive: true });
}

function getFfmpegBundleCandidates() {
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  // dev path and packaged path candidates
  const candidates = [
    path.join(app.getAppPath(), "bin", process.platform, exe),
    path.join(process.resourcesPath, "bin", process.platform, exe),
    path.join(process.resourcesPath, "ffmpeg", process.platform, exe),
    path.join(app.getAppPath(), "..", "bin", process.platform, exe),
  ];
  return [...new Set(candidates)];
}

function resolveBundledFfmpeg() {
  const candidates = getFfmpegBundleCandidates();
  const found = candidates.find((p) => fssync.existsSync(p));
  return {
    found: Boolean(found),
    path: found || null,
    candidates,
    mode: "bundled" as const,
  };
}

function createJobFileName(jobName: string) {
  const safe = (jobName || "untitled")
    .replace(/[\\/:*?"<>|]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80) || "untitled";
  return `${new Date().toISOString().replace(/[:.]/g, "-")}-${safe}.json`;
}

async function writeBridgeJobFile(payload: unknown, jobName: string) {
  await ensureJobStorageDir();
  const filePath = path.join(getJobStorageDir(), createJobFileName(jobName));
  await fs.writeFile(filePath, JSON.stringify(payload, null, 2), "utf8");
  return filePath;
}

function getRenderWorkerScriptPath() {
  return path.join(__dirname, "render-worker.js");
}

function resolveRendererHtmlPath() {
  const candidates = [
    path.join(app.getAppPath(), "src", "index.html"),
    path.join(__dirname, "../../src/index.html"),
    path.join(process.resourcesPath, "app", "src", "index.html"),
  ];
  const found = candidates.find((p) => fssync.existsSync(p));
  return found || candidates[0];
}

function resolveIconPath(): string | undefined {
  const candidates = [
    path.join(app.getAppPath(), "assets", "icon.png"),
    path.join(__dirname, "../../assets/icon.png"),
    path.join(process.resourcesPath, "app", "assets", "icon.png"),
  ];
  const found = candidates.find((p) => fssync.existsSync(p));
  return found;
}

function resolveProgressHtmlPath() {
  const candidates = [
    path.join(app.getAppPath(), "src", "progress.html"),
    path.join(__dirname, "../../src/progress.html"),
    path.join(process.resourcesPath, "app", "src", "progress.html"),
  ];
  const found = candidates.find((p) => fssync.existsSync(p));
  return found || candidates[0];
}

function sendRenderProgressToWindows(payload: { progress: number; phase: string; message: string }) {
  latestRenderProgress = payload;
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send("render:progress", payload);
  }
  if (progressWindow && !progressWindow.isDestroyed()) {
    progressWindow.webContents.send("render:progress", payload);
  }
}

function createProgressWindow() {
  if (progressWindow && !progressWindow.isDestroyed()) {
    progressWindow.show();
    progressWindow.focus();
    return progressWindow;
  }

  const progressIconPath = resolveIconPath();
  progressWindow = new BrowserWindow({
    width: 390,
    height: 440,
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    autoHideMenuBar: true,
    title: "Crafly Render Progress",
    ...(progressIconPath && { icon: progressIconPath }),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  const area = display.workArea;
  const [w, h] = progressWindow.getSize();
  const margin = 16;
  progressWindow.setPosition(area.x + area.width - w - margin, area.y + area.height - h - margin);

  progressWindow.loadFile(resolveProgressHtmlPath());
  progressWindow.on("closed", () => {
    progressWindow = null;
  });
  progressWindow.webContents.once("did-finish-load", () => {
    if (latestRenderProgress) {
      progressWindow?.webContents.send("render:progress", latestRenderProgress);
    }
  });
  return progressWindow;
}

function startRenderWorker(params: {
  jobPath: string;
  outputPath: string;
  ffmpegPath: string | null;
  jobName: string;
}) {
  if (!mainWindow) return;

  if (activeRenderWorker && !activeRenderWorker.killed) {
    try {
      activeRenderWorker.kill();
    } catch {
      // ignore
    }
  }
  createProgressWindow();
  sendRenderProgressToWindows({
    progress: 1,
    phase: "prepare",
    message: `렌더 시작: ${params.jobName}`,
  });

  const workerScript = getRenderWorkerScriptPath();
  if (!fssync.existsSync(workerScript)) {
    void simulateRenderProgressFromBridge(params.jobName);
    sendRenderProgressToWindows({
      progress: 100,
      phase: "done",
      message: `Worker script missing, simulated only: ${params.jobName}`,
    });
    return;
  }

  const worker = fork(workerScript, [], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    env: {
      ...process.env,
      CRAFTLY_JOB_PATH: params.jobPath,
      CRAFTLY_OUTPUT_PATH: params.outputPath,
      CRAFTLY_FFMPEG_PATH: params.ffmpegPath || "",
      CRAFTLY_JOB_NAME: params.jobName,
      CRAFTLY_RESOURCES_PATH: process.resourcesPath || "",
    },
  });
  activeRenderWorker = worker;

  worker.stdout?.on("data", (chunk) => {
    console.log(`[RenderWorker] ${String(chunk).trim()}`);
  });
  worker.stderr?.on("data", (chunk) => {
    console.warn(`[RenderWorker] ${String(chunk).trim()}`);
  });

  worker.on("message", (msg: any) => {
    if (!mainWindow) return;
    if (msg?.type === "progress") {
      sendRenderProgressToWindows({
        progress: Number(msg.progress || 0),
        phase: msg.phase || "render",
        message: msg.message || "",
      });
    }
    if (msg?.type === "snapshot" && msg.data) {
      // 렌더 미리보기 스냅샷을 프로그레스 윈도우로 전달
      if (progressWindow && !progressWindow.isDestroyed()) {
        progressWindow.webContents.send("render:snapshot", { data: msg.data });
      }
    }
    if (msg?.type === "done") {
      sendRenderProgressToWindows({
        progress: 100,
        phase: "done",
        message: msg.outputPath ? `완료: ${msg.outputPath}` : "완료",
      });
    }
    if (msg?.type === "error") {
      sendRenderProgressToWindows({
        progress: Number(msg.progress || 0),
        phase: "error",
        message: msg.message || "Render worker failed",
      });
    }
  });

  worker.on("exit", () => {
    if (activeRenderWorker === worker) activeRenderWorker = null;
  });
}

function createWindow() {
  const iconPath = resolveIconPath();
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 820,
    minWidth: 980,
    minHeight: 680,
    title: "Crafly Desktop Renderer",
    ...(iconPath && { icon: iconPath }),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.loadFile(resolveRendererHtmlPath());
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle("job:open", async () => {
  if (!mainWindow) return null;
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [{ name: "Crafly Render Job", extensions: ["json"] }],
  });

  if (result.canceled || result.filePaths.length === 0) return null;
  const filePath = result.filePaths[0];
  const text = await fs.readFile(filePath, "utf8");
  const raw = JSON.parse(text);
  const stat = await fs.stat(filePath);

  const summary: LoadedJobSummary = { path: filePath, size: stat.size, raw };
  return summary;
});

ipcMain.handle("bridge:health", async () => {
  await ensureDefaultOutputDir();
  await ensureJobStorageDir();
  return {
    ok: true,
    bridgePort: BRIDGE_PORT,
    version: app.getVersion(),
    outputDir: getDefaultOutputDir(),
    jobDir: getJobStorageDir(),
    ffmpeg: resolveBundledFfmpeg(),
  };
});

ipcMain.handle("preferences:get", async () => {
  return loadPreferencesSync();
});

ipcMain.handle("preferences:setOutputDir", async () => {
  if (!mainWindow) return { ok: false, error: "No window" };
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ["openDirectory", "createDirectory"],
    title: "기본 저장 폴더 선택",
    buttonLabel: "선택",
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { ok: false, canceled: true };
  }
  const chosen = result.filePaths[0];
  const prefs = loadPreferencesSync();
  prefs.outputDir = chosen;
  await savePreferences(prefs);
  await fs.mkdir(chosen, { recursive: true });
  return { ok: true, outputDir: chosen };
});

ipcMain.handle("shell:openPath", async (_event, targetPath: string) => {
  if (!targetPath) return { ok: false, error: "Missing path" };
  // 출력 디렉터리와 에셋 캐시 디렉터리만 허용
  const resolved = path.resolve(targetPath);
  const allowedDirs = [getDefaultOutputDir(), getAssetCacheDir()];
  const isAllowed = allowedDirs.some((dir) => resolved.startsWith(path.resolve(dir)));
  if (!isAllowed) return { ok: false, error: "Path not allowed" };
  const result = await shell.openPath(targetPath);
  if (result) return { ok: false, error: result };
  return { ok: true };
});

ipcMain.handle("shell:openExternal", async (_event, url: string) => {
  if (!url) return { ok: false, error: "Missing url" };
  // https:// 프로토콜만 허용 (file://, data:, javascript: 등 차단)
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { ok: false, error: "Only http/https URLs are allowed" };
    }
  } catch {
    return { ok: false, error: "Invalid URL" };
  }
  await shell.openExternal(url);
  return { ok: true };
});

ipcMain.handle("render:cancel", async () => {
  if (activeRenderWorker && !activeRenderWorker.killed) {
    try {
      activeRenderWorker.kill();
      activeRenderWorker = null;
      sendRenderProgressToWindows({
        progress: latestRenderProgress?.progress ?? 0,
        phase: "error",
        message: "렌더 취소됨",
      });
      return { ok: true, cancelled: true };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : "Cancel failed" };
    }
  }
  return { ok: true, cancelled: false };
});

ipcMain.handle("render:start", async (_event, payload: { jobPath?: string }) => {
  if (!mainWindow) return { ok: false, error: "No window" };
  await ensureDefaultOutputDir();
  if (!payload.jobPath) return { ok: false, error: "Missing jobPath" };

  let raw: any;
  try {
    raw = JSON.parse(await fs.readFile(payload.jobPath, "utf8"));
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "Job read failed" };
  }

  const ffmpeg = resolveBundledFfmpeg();
  const requested = raw?.output?.filePath || raw?.job?.output?.filePath || `${path.basename(payload.jobPath, ".json")}.mp4`;
  const outputPath = path.isAbsolute(requested)
    ? requested
    : path.join(getDefaultOutputDir(), path.basename(requested));
  startRenderWorker({
    jobPath: payload.jobPath,
    outputPath,
    ffmpegPath: ffmpeg.path,
    jobName: raw?.title || path.basename(payload.jobPath),
  });

  return { ok: true, outputPath, ffmpeg };
});

async function simulateRenderProgressFromBridge(jobName: string) {
  if (!mainWindow) return;
  const steps = [3, 12, 24, 39, 52, 66, 79, 91, 100];
  for (const progress of steps) {
    await new Promise((r) => setTimeout(r, 220));
    mainWindow.webContents.send("render:progress", {
      progress,
      phase: progress < 20 ? "prepare" : progress < 90 ? "render" : "mux",
      message: `Bridge job: ${jobName}`,
    });
  }
}

function sendJson(res: http.ServerResponse, statusCode: number, body: unknown, origin?: string) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    ...getCorsHeaders(origin),
  });
  res.end(JSON.stringify(body));
}

function guessExtensionFromMime(mimeType: string | undefined): string {
  const mime = (mimeType || "").toLowerCase();
  if (mime.includes("png")) return ".png";
  if (mime.includes("jpeg") || mime.includes("jpg")) return ".jpg";
  if (mime.includes("webp")) return ".webp";
  if (mime.includes("gif")) return ".gif";
  if (mime.includes("mp4")) return ".mp4";
  if (mime.includes("mpeg") || mime.includes("mp3")) return ".mp3";
  if (mime.includes("wav")) return ".wav";
  if (mime.includes("ogg")) return ".ogg";
  if (mime.includes("aac")) return ".aac";
  if (mime.includes("m4a")) return ".m4a";
  return "";
}

function startBridgeServer() {
  if (bridgeServer) return;

  bridgeServer = http.createServer((req, res) => {
    const url = req.url || "/";
    const method = req.method || "GET";
    const origin = req.headers.origin;

    if (method === "OPTIONS") {
      res.writeHead(204, getCorsHeaders(origin));
      res.end();
      return;
    }

    // Origin 검증: 허용된 출처가 아니면 거부
    if (origin && !isAllowedOrigin(origin)) {
      sendJson(res, 403, { ok: false, error: "Forbidden origin" }, origin);
      return;
    }

    if (method === "GET" && url === "/health") {
      const ffmpeg = resolveBundledFfmpeg();
      sendJson(res, 200, {
        ok: true,
        app: "crafly-desktop",
        bridgePort: BRIDGE_PORT,
        version: app.getVersion(),
        ffmpegFound: ffmpeg.found,
      }, origin);
      return;
    }

    // 에셋 캐시 존재 확인 (웹에서 전송 전에 이미 있는지 체크)
    if (method === "POST" && url === "/asset/check") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
          const keys: string[] = Array.isArray(body?.keys) ? body.keys : [];
          const cacheDir = getAssetCacheDir();
          const existing: Record<string, string> = {};
          for (const key of keys) {
            const safeBase = (key || "asset").replace(/[\\/:*?"<>|]/g, "_").replace(/\s+/g, " ").trim().slice(0, 120) || "asset";
            // 확장자 모를 수 있으므로 prefix 매칭
            const files = fssync.existsSync(cacheDir)
              ? fssync.readdirSync(cacheDir).filter((f) => f.startsWith(safeBase))
              : [];
            if (files.length > 0) {
              existing[key] = path.join(cacheDir, files[0]);
            }
          }
          sendJson(res, 200, { ok: true, existing }, origin);
        } catch {
          sendJson(res, 400, { ok: false, error: "Invalid body" }, origin);
        }
      });
      return;
    }

    if (method === "POST" && url.startsWith("/asset")) {
      const requestUrl = new URL(url, `http://127.0.0.1:${BRIDGE_PORT}`);
      const key = (requestUrl.searchParams.get("key") || "").trim();
      const name = (requestUrl.searchParams.get("name") || "asset").trim();
      const ext = (requestUrl.searchParams.get("ext") || "").trim();
      const mimeType = req.headers["content-type"] || "application/octet-stream";

      void (async () => {
        try {
          await ensureAssetCacheDir();
          const chunks: Buffer[] = [];
          for await (const chunk of req) {
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
          }
          const data = Buffer.concat(chunks);
          if (data.length === 0) {
            sendJson(res, 400, { ok: false, error: "Empty asset body" }, origin);
            return;
          }

          const safeBase = (key || name || "asset")
            .replace(/[\\/:*?"<>|]/g, "_")
            .replace(/\s+/g, " ")
            .trim()
            .slice(0, 120) || "asset";
          const suffix = ext || guessExtensionFromMime(Array.isArray(mimeType) ? mimeType[0] : mimeType);
          const finalPath = path.join(getAssetCacheDir(), `${safeBase}${suffix}`);

          if (!fssync.existsSync(finalPath)) {
            await fs.writeFile(finalPath, data);
          }

          sendJson(res, 200, {
            ok: true,
            localPath: finalPath,
            bytes: data.length,
          }, origin);
        } catch (error) {
          sendJson(res, 500, {
            ok: false,
            error: error instanceof Error ? error.message : "Asset upload failed",
          }, origin);
        }
      })();
      return;
    }

    if (method === "POST" && url === "/render") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      req.on("end", async () => {
        try {
          const rawText = Buffer.concat(chunks).toString("utf8") || "{}";
          const payload = JSON.parse(rawText) as {
            title?: string;
            episodeId?: string;
            job?: { version?: string; output?: { filePath?: string } };
          };
          await ensureDefaultOutputDir();
          await ensureJobStorageDir();
          const ffmpeg = resolveBundledFfmpeg();

          const jobName = payload.title || payload.episodeId || "untitled";
          const requestedFileName = payload.job?.output?.filePath || `${jobName}.mp4`;
          const finalOutputPath = path.join(getDefaultOutputDir(), path.basename(requestedFileName));
          const payloadWithResolvedOutput = {
            ...payload,
            job: {
              ...(payload.job || {}),
              output: {
                ...((payload.job && payload.job.output) || {}),
                filePath: finalOutputPath,
              },
            },
          };
          const savedJobPath = await writeBridgeJobFile(payloadWithResolvedOutput, jobName);
          mainWindow?.webContents.send("bridge:incoming-job", {
            receivedAt: new Date().toISOString(),
            jobName,
            output: finalOutputPath,
            ffmpegFound: ffmpeg.found,
            jobPath: savedJobPath,
          });
          if (progressWindow && !progressWindow.isDestroyed()) {
            progressWindow.webContents.send("bridge:incoming-job", {
              receivedAt: new Date().toISOString(),
              jobName,
              output: finalOutputPath,
              ffmpegFound: ffmpeg.found,
              jobPath: savedJobPath,
            });
          }

          startRenderWorker({
            jobPath: savedJobPath,
            outputPath: finalOutputPath,
            ffmpegPath: ffmpeg.path,
            jobName,
          });

          sendJson(res, 202, {
            ok: true,
            accepted: true,
            message: "Render job accepted",
          }, origin);
        } catch (error) {
          sendJson(res, 400, {
            ok: false,
            error: error instanceof Error ? error.message : "Invalid payload",
          }, origin);
        }
      });
      return;
    }

    sendJson(res, 404, { ok: false, error: "Not found" }, origin);
  });

  bridgeServer.listen(BRIDGE_PORT, "127.0.0.1", () => {
    console.log(`[CraflyDesktop] bridge listening on http://127.0.0.1:${BRIDGE_PORT}`);
  });
}

app.whenReady().then(() => {
  void ensureDefaultOutputDir().catch((error) => {
    console.warn("[CraflyDesktop] failed to create default output dir:", error);
  });
  void ensureAssetCacheDir().catch((error) => {
    console.warn("[CraflyDesktop] failed to create asset cache dir:", error);
  });
  createWindow();
  startBridgeServer();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (activeRenderWorker && !activeRenderWorker.killed) {
    try {
      activeRenderWorker.kill();
    } catch {
      // ignore
    }
    activeRenderWorker = null;
  }
  if (progressWindow && !progressWindow.isDestroyed()) {
    progressWindow.close();
    progressWindow = null;
  }
  if (bridgeServer) {
    bridgeServer.close();
    bridgeServer = null;
  }
  if (process.platform !== "darwin") app.quit();
});
