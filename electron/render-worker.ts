import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as fssync from "node:fs";
import { spawn } from "node:child_process";

type BridgeJob = {
  title?: string;
  job?: {
    timeline?: {
      duration?: number;
      media?: Array<{
        sceneId?: string;
        type?: "image" | "video" | string;
        url?: string;
        filePath?: string;
        startTime?: number;
        endTime?: number;
      }>;
      audio?: Array<{
        role?: "voice" | "bgm" | string;
        url?: string;
        filePath?: string;
        volume?: number;
        fadeInSec?: number;
        fadeOutSec?: number;
      }>;
      subtitles?: Array<{
        text?: string;
        startTime?: number;
        endTime?: number;
        fontSize?: number;
        fontFamily?: string;
        color?: string;
        outlineColor?: string;
        outlineWidth?: number;
        backgroundColor?: string;
        backgroundOpacity?: number;
        textAlign?: "left" | "center" | "right" | string;
      }>;
      animations?: Array<{
        sceneId?: string;
        type?: "move-up" | "move-down" | "move-left" | "move-right" | "zoom-in" | "zoom-out" | "none" | string;
        startTime?: number;
        endTime?: number;
        params?: {
          zoom?: { start?: number; end?: number };
          pan?: { x?: number; y?: number };
        };
      }>;
    };
    output?: {
      width?: number;
      height?: number;
      fps?: number;
      filePath?: string;
    };
  };
};

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

const isMacOS = process.platform === "darwin";

function getVideoEncoderArgs(): string[] {
  if (isMacOS) {
    // macOS 하드웨어 인코더: libx264 대비 5~10배 빠름
    return ["-c:v", "h264_videotoolbox", "-q:v", "65"];
  }
  return ["-c:v", "libx264", "-preset", "veryfast"];
}

function parseDurationSeconds(job: BridgeJob): number {
  const raw = Number(job?.job?.timeline?.duration ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 5;
  return clamp(raw, 1, 60 * 60 * 6);
}

function parseVideoSpec(job: BridgeJob) {
  const width = clamp(Math.round(Number(job?.job?.output?.width ?? 1920) || 1920), 240, 3840);
  const height = clamp(Math.round(Number(job?.job?.output?.height ?? 1080) || 1080), 240, 3840);
  const fps = clamp(Math.round(Number(job?.job?.output?.fps ?? 30) || 30), 1, 60);
  return { width, height, fps };
}

function ffmpegTimeToSec(tc: string): number {
  const m = tc.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function formatSrtTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.floor((clamped % 1) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}

function formatAssTime(seconds: number): string {
  const clamped = Math.max(0, seconds);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const cs = Math.floor((clamped % 1) * 100); // centiseconds
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

type SubtitleEntry = {
  text: string;
  startTime: number;
  endTime: number;
  position?: { x?: number; y?: number };
  fontSize?: number;
  fontFamily?: string;
  color?: string;
  outlineColor?: string;
  outlineWidth?: number;
  backgroundColor?: string;
  backgroundOpacity?: number;
  textAlign?: string;
  maxWidth?: number;
};

function getSubtitleEntries(job: BridgeJob): SubtitleEntry[] {
  const items = Array.isArray(job?.job?.timeline?.subtitles) ? job.job!.timeline!.subtitles! : [];
  return items
    .map((s) => ({
      text: String(s?.text || "").trim(),
      startTime: Number(s?.startTime ?? 0),
      endTime: Number(s?.endTime ?? 0),
      position: (s as any)?.position,
      fontSize: Number(s?.fontSize ?? NaN),
      fontFamily: typeof s?.fontFamily === "string" ? s.fontFamily : undefined,
      color: typeof s?.color === "string" ? s.color : undefined,
      outlineColor: typeof s?.outlineColor === "string" ? s.outlineColor : undefined,
      outlineWidth: Number(s?.outlineWidth ?? NaN),
      backgroundColor: typeof s?.backgroundColor === "string" ? s.backgroundColor : undefined,
      backgroundOpacity: Number(s?.backgroundOpacity ?? NaN),
      textAlign: typeof s?.textAlign === "string" ? s.textAlign : undefined,
      maxWidth: Number((s as any)?.maxWidth ?? NaN),
    }))
    .filter((s) => s.text.length > 0 && Number.isFinite(s.startTime) && Number.isFinite(s.endTime) && s.endTime > s.startTime);
}

async function writeTempSrt(subtitles: Array<{ text: string; startTime: number; endTime: number }>, jobName: string) {
  const safe = (jobName || "subtitle").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "subtitle";
  const srtPath = path.join(path.dirname(process.env.CRAFTLY_OUTPUT_PATH || "."), `${safe}.crafly-temp.srt`);
  const body = subtitles
    .map((s, idx) => `${idx + 1}\n${formatSrtTime(s.startTime)} --> ${formatSrtTime(s.endTime)}\n${s.text.replace(/\r\n/g, "\n")}`)
    .join("\n\n");
  await fs.writeFile(srtPath, `${body}\n`, "utf8");
  return srtPath;
}

function escapeSubtitleFilterPath(filePath: string): string {
  let p = filePath.replace(/\\/g, "/");
  p = p.replace(/:/g, "\\:");
  p = p.replace(/'/g, "\\'");
  return p;
}

function escapeAssText(text: string): string {
  return String(text || "")
    .replace(/\\/g, "\\\\")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/\n/g, "\\N")
    .replace(/\{/g, "\\{")
    .replace(/\}/g, "\\}");
}

function escapeAssOverrideText(text: string): string {
  return String(text || "").replace(/\\/g, "\\\\").replace(/\{/g, "\\{").replace(/\}/g, "\\}");
}

// BG 레이어용: 반각 문장부호를 전각으로 치환하여 글리프 높이를 한글과 동일하게 맞춤
// (BG 텍스트는 \1a&HFF&로 투명이므로 시각적 영향 없음, 박스 높이만 통일)
const HALFWIDTH_TO_FULLWIDTH: Record<string, string> = {
  ",": "\uFF0C", ".": "\uFF0E", "!": "\uFF01", "?": "\uFF1F",
  ":": "\uFF1A", ";": "\uFF1B", "'": "\uFF07", '"': "\uFF02",
  "(": "\uFF08", ")": "\uFF09", "-": "\uFF0D", "/": "\uFF0F",
  "_": "\uFF3F", "~": "\uFF5E",
};
function uniformHeightText(text: string): string {
  let out = "";
  for (const ch of text) {
    out += HALFWIDTH_TO_FULLWIDTH[ch] || ch;
  }
  return out;
}

function parseHexColorToRgb(hex?: string): { r: number; g: number; b: number } | null {
  const raw = String(hex || "").trim().replace(/^#/, "");
  const normalized =
    raw.length === 3
      ? raw.split("").map((c) => c + c).join("")
      : raw.length >= 6
      ? raw.slice(0, 6)
      : "";
  if (!/^[0-9a-fA-F]{6}$/.test(normalized)) return null;
  return {
    r: parseInt(normalized.slice(0, 2), 16),
    g: parseInt(normalized.slice(2, 4), 16),
    b: parseInt(normalized.slice(4, 6), 16),
  };
}

function toAssColor(hex?: string, alpha01?: number): string | null {
  const rgb = parseHexColorToRgb(hex);
  if (!rgb) return null;
  const alpha =
    typeof alpha01 === "number" && Number.isFinite(alpha01)
      ? clamp(Math.round((1 - clamp(alpha01, 0, 1)) * 255), 0, 255)
      : 0;
  const aa = alpha.toString(16).padStart(2, "0").toUpperCase();
  const bb = rgb.b.toString(16).padStart(2, "0").toUpperCase();
  const gg = rgb.g.toString(16).padStart(2, "0").toUpperCase();
  const rr = rgb.r.toString(16).padStart(2, "0").toUpperCase();
  return `&H${aa}${bb}${gg}${rr}`;
}

// ASS 색상 (알파 없이, &HBBGGRR& 형식) — override 태그용
function toAssBGR(hex?: string): string {
  const rgb = parseHexColorToRgb(hex);
  if (!rgb) return "&H000000&";
  const bb = rgb.b.toString(16).padStart(2, "0").toUpperCase();
  const gg = rgb.g.toString(16).padStart(2, "0").toUpperCase();
  const rr = rgb.r.toString(16).padStart(2, "0").toUpperCase();
  return `&H${bb}${gg}${rr}&`;
}

// ASS 알파 태그 값 (opacity 0~1 → &HAA& 형식, 00=불투명, FF=투명)
function toAssAlpha(opacity: number): string {
  const alpha = clamp(Math.round((1 - clamp(opacity, 0, 1)) * 255), 0, 255);
  return `&H${alpha.toString(16).padStart(2, "0").toUpperCase()}&`;
}

// 번들 폰트 디렉터리 경로 (개발: assets/fonts, 빌드: resources/fonts)
function getBundledFontsDir(): string {
  // electron-builder extraResources: { from: "assets/fonts", to: "fonts" }
  // 빌드 후: <appPath>/Contents/Resources/fonts (macOS) 또는 resources/fonts (Windows)
  const resourcesPath = process.env.CRAFTLY_RESOURCES_PATH || "";
  if (resourcesPath) {
    const built = path.join(resourcesPath, "fonts");
    if (fssync.existsSync(built)) return built;
  }
  // 개발 모드: __dirname은 dist/electron/ → 프로젝트 루트는 ../../
  const candidates = [
    path.resolve(__dirname, "..", "..", "assets", "fonts"),
    path.resolve(__dirname, "..", "assets", "fonts"),
  ];
  for (const p of candidates) {
    if (fssync.existsSync(p)) return p;
  }
  return "";
}

// 웹 폰트명 → 번들 폰트 파일의 font family name 매핑
const FONT_FAMILY_MAP: Record<string, string> = {
  "Pretendard":        "Pretendard",
  "Pretendard Black":  "Pretendard Black",
  "Pretendard Bold":   "Pretendard",
  "BMEULJIRO":         "BMEULJIRO",
  "Euljiro":           "BMEULJIRO",
  "을지로":            "BMEULJIRO",
  "Do Hyeon":          "Do Hyeon",
  "도현":              "Do Hyeon",
  "Yeon Sung":         "Yeon Sung",
  "연성":              "Yeon Sung",
  "MaruBuri Bold":     "MaruBuri Bold",
  "MaruBuri":          "MaruBuri Bold",
  "마루부리":          "MaruBuri Bold",
};

function resolveAssFont(fontFamily?: string): string {
  const name = (fontFamily || "").trim();
  if (!name) return "Pretendard";
  // 번들 매핑에 있으면 그대로 사용
  if (FONT_FAMILY_MAP[name]) return FONT_FAMILY_MAP[name];
  // 부분 매칭 시도 (예: "배달의민족 을지로" → "BMEULJIRO")
  const lower = name.toLowerCase();
  if (lower.includes("을지로") || lower.includes("euljiro")) return "BMEULJIRO";
  if (lower.includes("도현") || lower.includes("dohyeon") || lower.includes("do hyeon")) return "Do Hyeon";
  if (lower.includes("연성") || lower.includes("yeonsung") || lower.includes("yeon sung")) return "Yeon Sung";
  if (lower.includes("마루부리") || lower.includes("maruburi")) return "MaruBuri Bold";
  if (lower.includes("pretendard")) return name.includes("Black") ? "Pretendard Black" : "Pretendard";
  return name;
}

// 한 줄의 텍스트 폭(px)을 추정
function estimateLineWidthPx(line: string, fontSize: number): number {
  let w = 0;
  for (const char of line) {
    const code = char.codePointAt(0) || 0;
    // 한글 음절(가-힣) + CJK
    if ((code >= 0xAC00 && code <= 0xD7AF) || (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3000 && code <= 0x303F)) {
      w += fontSize * 0.85;
    } else if (code === 0x20) {
      w += fontSize * 0.28;
    } else {
      w += fontSize * 0.50;
    }
  }
  return w;
}

// 텍스트 블록의 크기(px)를 추정 (배경 사각형 그리기용, 웹 canvas 기준에 맞춤)
function estimateTextBlockSize(text: string, fontSize: number, maxWidthChars?: number): { width: number; height: number } {
  const lineHeight = fontSize * 1.3;
  // 웹과 동일: maxWidth = Math.max(240, maxWidthChars * fontSize * 0.62)
  const maxPixelWidth = Math.max(240, (maxWidthChars ?? 18) * (fontSize * 0.62));

  // 먼저 원본 줄 분리, 각 줄이 maxPixelWidth를 넘으면 래핑
  const rawLines = text.split(/\n/);
  const wrappedLines: string[] = [];
  for (const raw of rawLines) {
    const w = estimateLineWidthPx(raw, fontSize);
    if (w <= maxPixelWidth) {
      wrappedLines.push(raw);
    } else {
      // 간단한 글자 단위 래핑
      let cur = "";
      let curW = 0;
      for (const char of raw) {
        const code = char.codePointAt(0) || 0;
        const cw = (code >= 0xAC00 && code <= 0xD7AF) || (code >= 0x4E00 && code <= 0x9FFF) || (code >= 0x3000 && code <= 0x303F)
          ? fontSize * 0.85
          : code === 0x20 ? fontSize * 0.28 : fontSize * 0.50;
        if (curW + cw > maxPixelWidth && cur.length > 0) {
          wrappedLines.push(cur);
          cur = char;
          curW = cw;
        } else {
          cur += char;
          curW += cw;
        }
      }
      if (cur) wrappedLines.push(cur);
    }
  }

  let maxWidth = 0;
  for (const line of wrappedLines) {
    maxWidth = Math.max(maxWidth, estimateLineWidthPx(line, fontSize));
  }
  return { width: Math.min(maxWidth, maxPixelWidth), height: Math.max(1, wrappedLines.length) * lineHeight };
}

async function writeTempAss(subtitles: SubtitleEntry[], jobName: string, outputWidth: number, outputHeight: number) {
  const safe = (jobName || "subtitle").replace(/[\\/:*?"<>|]/g, "_").slice(0, 60) || "subtitle";
  const assPath = path.join(path.dirname(process.env.CRAFTLY_OUTPUT_PATH || "."), `${safe}.crafly-temp.ass`);
  const isShort = outputHeight > outputWidth;
  const referencePreviewWidth = isShort ? 520 : 960;
  const subtitleScale = clamp(outputWidth / referencePreviewWidth, 0.5, 4);
  const defaultFont = resolveAssFont("Pretendard");

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${Math.round(outputWidth)}`,
    `PlayResY: ${Math.round(outputHeight)}`,
    "ScaledBorderAndShadow: yes",
    "WrapStyle: 2",
    "",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    // BG 스타일: BorderStyle=3 (opaque box, libass가 실제 텍스트 폭에 맞게 박스 자동 생성)
    `Style: BG,${defaultFont},34,&HFF000000,&HFF000000,&H80000000,&H80000000,0,0,0,0,100,100,0,0,3,6,0,5,20,20,40,1`,
    // Text 스타일: BorderStyle=1 (외곽선만)
    `Style: Text,${defaultFont},34,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,5,20,20,40,1`,
    "",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const events: string[] = [];

  for (const s of subtitles) {
    const align = (s.textAlign || "center").toLowerCase();
    const an = align === "left" ? 4 : align === "right" ? 6 : 5;
    const x = clamp((Number(s.position?.x ?? 50) / 100) * outputWidth, 0, outputWidth);
    const y = clamp((Number(s.position?.y ?? 84) / 100) * outputHeight, 0, outputHeight);

    // libass는 canvas 대비 글자가 약간 작게 렌더되므로 1.1배 보정
    const fontSize = clamp(
      (Number.isFinite(s.fontSize) ? Number(s.fontSize) : 34) * subtitleScale * 1.1,
      10,
      240
    );
    const outlineWidth = clamp(
      (Number.isFinite(s.outlineWidth) ? Number(s.outlineWidth) : 2) * subtitleScale,
      0,
      24
    );
    const fontName = resolveAssFont(s.fontFamily);
    const isBold = (s.fontFamily || "").includes("Black") || (s.fontFamily || "").includes("Bold");

    const startTime = formatAssTime(s.startTime);
    const endTime = formatAssTime(s.endTime);
    const assText = escapeAssText(s.text);

    // 색상 (알파 분리)
    const textColorBGR = toAssBGR(s.color || "#FFFFFF");
    const outlineColorBGR = toAssBGR(s.outlineColor || "#000000");
    const bgColorBGR = toAssBGR(s.backgroundColor || "#000000");
    const bgOpacity = clamp(Number.isFinite(s.backgroundOpacity) ? Number(s.backgroundOpacity) : 0.5, 0, 1);
    const bgAlpha = toAssAlpha(bgOpacity);

    // 배경 박스 패딩 (축소: 좌우 1/2, 위아래 1/3)
    const boxPad = Math.round(6 * subtitleScale);

    // ── 레이어 0: 배경 박스 (BorderStyle=3) ──
    // libass가 실제 렌더된 텍스트 폭에 맞춰 박스를 자동 생성 → 항상 일정한 크기
    if (bgOpacity > 0.01) {
      const bgTags = [
        `\\an${an}`,
        `\\pos(${Math.round(x)},${Math.round(y)})`,
        `\\fn${fontName}`,
        `\\fs${fontSize.toFixed(1)}`,
        isBold ? "\\b1" : "",
        `\\1a&HFF&`,            // 텍스트 완전 투명 (박스만 보이게)
        `\\3c${bgColorBGR}`,    // 박스 테두리 = 배경색
        `\\3a${bgAlpha}`,       // 박스 테두리 투명도
        `\\4c${bgColorBGR}`,    // 박스 채우기 = 배경색
        `\\4a${bgAlpha}`,       // 박스 채우기 투명도
        `\\bord${boxPad}`,      // 텍스트~박스 간격
        `\\shad0`,
        `\\q2`,
      ].join("");
      const bgText = escapeAssText(uniformHeightText(s.text));
      events.push(`Dialogue: 0,${startTime},${endTime},BG,,0,0,0,,{${bgTags}}${bgText}`);
    }

    // ── 레이어 1: 텍스트 + 외곽선 ──
    // BorderStyle=1: \3c=외곽선색, \bord=외곽선 두께
    const textTags = [
      `\\an${an}`,
      `\\pos(${Math.round(x)},${Math.round(y)})`,
      `\\fn${fontName}`,
      `\\fs${fontSize.toFixed(1)}`,
      isBold ? "\\b1" : "",
      `\\1c${textColorBGR}`,    // 텍스트 색상
      `\\1a&H00&`,              // 텍스트 불투명
      `\\3c${outlineColorBGR}`, // 외곽선 색상
      `\\3a&H00&`,              // 외곽선 불투명
      `\\bord${outlineWidth.toFixed(1)}`, // 외곽선 두께
      `\\shad0`,
      `\\q2`,
    ].join("");
    events.push(`Dialogue: 1,${startTime},${endTime},Text,,0,0,0,,{${textTags}}${assText}`);
  }

  await fs.writeFile(assPath, `${header.join("\n")}\n${events.join("\n")}\n`, "utf8");
  return assPath;
}

async function runFfmpegProcessWithUiProgress(params: {
  ffmpegPath: string;
  args: string[];
  durationSec: number;
  initialProgress?: number;
  snapshotPath?: string;
  /** 장면별 누적 종료 시간 (이미지 타임라인 렌더 시 장면 카운트 표시용) */
  sceneCumulativeEnds?: number[];
}) {
  const { ffmpegPath, args, durationSec, initialProgress = 12, snapshotPath, sceneCumulativeEnds } = params;
  const totalScenes = sceneCumulativeEnds?.length ?? 0;

  await new Promise<void>((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderrBuf = "";
    let stderrTail = "";
    let lastProgress = initialProgress;
    let lastTimeTickAt = Date.now();
    const startedAt = Date.now();
    let inputCount = 0;
    let sawStreamMapping = false;
    let sawFirstEncodedTime = false;
    let lastTimeSec = 0;  // 가장 최근 time= 값 (장면 카운트 표시용)

    // 자막 burn-in(initialProgress >= 20) 여부에 따라 phase/message 결정
    const isSubtitlePass = initialProgress >= 20;
    // 각 구간별 pseudo-progress 상한선
    const progressCeiling = isSubtitlePass ? 98 : 55;
    // 렌더 본구간 범위 (time= 로그 기반)
    const renderFloor = 15;
    const renderCeiling = 92;
    const renderSpan = renderCeiling - renderFloor;

    // 현재 time= 기준으로 장면 인덱스 계산
    function getSceneIndex(sec: number): number {
      if (!sceneCumulativeEnds || totalScenes === 0) return -1;
      for (let i = 0; i < totalScenes; i++) {
        if (sec < sceneCumulativeEnds[i]) return i;
      }
      return totalScenes - 1;
    }

    // ── 스냅샷 미리보기: 주기적으로 썸네일 파일을 읽어 IPC로 전송 ──
    let lastSnapshotMtime = 0;
    const snapshotInterval = snapshotPath
      ? setInterval(async () => {
          try {
            const stat = fssync.statSync(snapshotPath);
            const mtime = stat.mtimeMs;
            if (mtime > lastSnapshotMtime && stat.size > 100) {
              lastSnapshotMtime = mtime;
              const data = await fs.readFile(snapshotPath);
              const base64 = data.toString("base64");
              process.send?.({ type: "snapshot", data: `data:image/jpeg;base64,${base64}` });
            }
          } catch {
            // 파일 아직 없거나 읽기 실패 — 무시
          }
        }, 1000)
      : null;

    const heartbeat = setInterval(() => {
      const idleMs = Date.now() - lastTimeTickAt;
      if (idleMs >= 4000) {
        if (!sawFirstEncodedTime) {
          const elapsedMs = Date.now() - startedAt;
          // 로그 감속 곡선: 처음엔 빠르게, 갈수록 느리게 상한선까지 올라감
          const logRatio = clamp(Math.log1p(elapsedMs / 40000) / Math.log1p(5), 0, 1);
          const pseudoProgress = Math.round(initialProgress + (progressCeiling - initialProgress) * logRatio);
          if (pseudoProgress > lastProgress) lastProgress = pseudoProgress;
        }
        const elapsedSec = Math.round((Date.now() - startedAt) / 1000);
        const elapsedMin = Math.floor(elapsedSec / 60);
        const elapsedRemSec = elapsedSec % 60;
        const elapsedStr = elapsedMin > 0
          ? `${elapsedMin}분 ${elapsedRemSec}초`
          : `${elapsedSec}초`;
        const phase = isSubtitlePass ? "mux" : (sawStreamMapping ? "render" : "prepare");
        let message: string;
        if (isSubtitlePass) {
          message = `자막을 넣고 있어요... (${elapsedStr} 경과)`;
        } else {
          const sceneIdx = getSceneIndex(lastTimeSec);
          if (sceneIdx >= 0 && totalScenes > 0 && sawFirstEncodedTime) {
            message = `장면 ${sceneIdx + 1}/${totalScenes} 처리 중... (${elapsedStr} 경과)`;
          } else {
            message = `영상 애니메이션을 적용하고 있어요... (${elapsedStr} 경과)`;
          }
        }
        process.send?.({
          type: "progress",
          progress: lastProgress,
          phase,
          message,
        });
      }
    }, 1500);

    const cleanup = () => {
      clearInterval(heartbeat);
      if (snapshotInterval) clearInterval(snapshotInterval);
      // 스냅샷 임시 파일 정리
      if (snapshotPath) {
        try { fssync.unlinkSync(snapshotPath); } catch { /* ignore */ }
      }
    };

    child.stderr.on("data", (chunk) => {
      const text = String(chunk);
      stderrTail = `${stderrTail}\n${text}`.slice(-8000);
      stderrBuf += text;
      const lines = stderrBuf.split(/\r?\n/);
      stderrBuf = lines.pop() || "";

      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line) continue;

        const isInputLine = line.startsWith("Input #");
        const isStreamMapping = line.startsWith("Stream mapping:");
        if (initialProgress < 20 && isInputLine) {
          inputCount += 1;
          const prepProgress = Math.min(13, Math.max(lastProgress, initialProgress + Math.min(1, Math.floor(inputCount / 2))));
          if (prepProgress > lastProgress) lastProgress = prepProgress;
        }
        if (initialProgress < 20 && isStreamMapping) {
          sawStreamMapping = true;
          lastProgress = Math.max(lastProgress, 14);
        }

        if (
          isInputLine ||
          isStreamMapping ||
          line.includes("Server returned") ||
          line.includes("Unauthorized")
        ) {
          process.send?.({
            type: "progress",
            progress: lastProgress,
            phase: isSubtitlePass ? "mux" : "prepare",
            message: isSubtitlePass ? "자막을 넣고 있어요..." : "영상 애니메이션을 적용하고 있어요...",
          });
        }

        const tMatch = line.match(/time=(\d+:\d+:\d+(?:\.\d+)?)/);
        if (!tMatch) continue;
        sawFirstEncodedTime = true;
        const sec = ffmpegTimeToSec(tMatch[1]);
        lastTimeSec = sec;
        const ratio = durationSec > 0 ? clamp(sec / durationSec, 0, 1) : 0;
        // time= 첫 등장 시 현재 lastProgress부터 이어서 올라감 (점프 없음)
        const progress = Math.max(lastProgress, Math.floor(renderFloor + ratio * renderSpan));
        lastTimeTickAt = Date.now();

        // 장면 카운트 메시지
        const sceneIdx = getSceneIndex(sec);
        let message: string;
        if (isSubtitlePass) {
          message = progress < renderCeiling ? "자막을 넣고 있어요..." : "거의 다 됐어요!";
        } else if (progress >= renderCeiling) {
          message = "거의 다 됐어요!";
        } else if (sceneIdx >= 0 && totalScenes > 0) {
          message = `장면 ${sceneIdx + 1}/${totalScenes} 처리 중...`;
        } else {
          message = "영상 애니메이션을 적용하고 있어요...";
        }

        if (progress > lastProgress) {
          lastProgress = progress;
          process.send?.({
            type: "progress",
            progress,
            phase: progress < renderCeiling ? "render" : "mux",
            message,
          });
        }
      }
    });

    child.on("error", (error) => {
      cleanup();
      reject(error);
    });
    child.on("exit", (code) => {
      cleanup();
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited with code ${code}: ${stderrTail.trim()}`));
    });
  });
}

async function runFfmpegPlaceholder(params: {
  ffmpegPath: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  outputPath: string;
  jobName: string;
}) {
  const { ffmpegPath, durationSec, width, height, fps, outputPath, jobName } = params;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await fs.unlink(outputPath);
  } catch {
    // ignore if not exists
  }

  const args = [
    "-y",
    "-f", "lavfi",
    "-i", `color=c=black:s=${width}x${height}:r=${fps}`,
    "-f", "lavfi",
    "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
    "-t", String(durationSec),
    ...getVideoEncoderArgs(),
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    outputPath,
  ];

  process.send?.({ type: "progress", progress: 12, phase: "prepare", message: "영상 렌더링을 시작합니다..." });

  await runFfmpegProcessWithUiProgress({
    ffmpegPath,
    args,
    durationSec,
    initialProgress: 12,
  });
}

function resolveMediaSource(job: BridgeJob): { kind: "image" | "video"; src: string } | null {
  const media = Array.isArray(job?.job?.timeline?.media) ? job.job!.timeline!.media! : [];
  const first = media.find((m) => (m?.url || m?.filePath) && (m?.type === "image" || m?.type === "video"));
  if (!first) return null;
  const src = String(first.filePath || first.url || "").trim();
  if (!src) return null;
  return { kind: first.type === "video" ? "video" : "image", src };
}

function resolveTimelineMedia(job: BridgeJob): Array<{
  sceneId: string;
  kind: "image" | "video";
  src: string;
  startTime: number;
  endTime: number;
}> {
  const media = Array.isArray(job?.job?.timeline?.media) ? job.job!.timeline!.media! : [];
  return media
    .map((m) => {
      const src = String(m?.filePath || m?.url || "").trim();
      const kind: "image" | "video" | null =
        m?.type === "video" ? "video" : m?.type === "image" ? "image" : null;
      const startTime = Number(m?.startTime ?? 0);
      const endTime = Number(m?.endTime ?? 0);
      if (!src || !kind) return null;
      return {
        sceneId: String(m?.sceneId || ""),
        kind,
        src,
        startTime: Number.isFinite(startTime) ? startTime : 0,
        endTime: Number.isFinite(endTime) ? endTime : 0,
      };
    })
    .filter((v): v is NonNullable<typeof v> => Boolean(v))
    .sort((a, b) => a.startTime - b.startTime);
}

type ResolvedAnimation = {
  type: string;
  startTime: number;
  endTime: number;
  params?: {
    zoom?: { start?: number; end?: number };
    pan?: { x?: number; y?: number };
  };
};

function resolveAnimationByScene(job: BridgeJob): Map<string, ResolvedAnimation> {
  const map = new Map<string, ResolvedAnimation>();
  const animations = Array.isArray(job?.job?.timeline?.animations) ? job.job!.timeline!.animations! : [];
  for (const a of animations) {
    const sceneId = String(a?.sceneId || "").trim();
    const type = String(a?.type || "").trim();
    if (!sceneId || !type) continue;
    map.set(sceneId, {
      type,
      startTime: Number(a?.startTime ?? 0),
      endTime: Number(a?.endTime ?? 0),
      params: a?.params,
    });
  }
  return map;
}

function buildImageSegmentFilter(params: {
  inputIndex: number;
  width: number;
  height: number;
  fps: number;
  duration: number;
  animation?: ResolvedAnimation | null;
}) {
  const { inputIndex, width, height, fps, duration, animation } = params;
  const d = Math.max(0.2, duration);
  const frameCount = Math.max(2, Math.round(d * fps));
  // FFmpeg expression 내 쉼표는 filter 구분자로 해석되므로 이스케이프 필요
  const p = `min(max(on/${Math.max(frameCount - 1, 1)}\\,0)\\,1)`;
  const animationType = String(animation?.type || "");

  const baseScale = 1.06;
  const panPreset = Math.max(
    Math.abs(Number(animation?.params?.pan?.x ?? 24)),
    Math.abs(Number(animation?.params?.pan?.y ?? 14))
  );
  const zoomStartPreset = Number(animation?.params?.zoom?.start ?? 1.1);
  const zoomEndPreset = Number(animation?.params?.zoom?.end ?? 1.18);
  const zoomDeltaPreset = Math.abs(zoomEndPreset - zoomStartPreset);
  const tierFactor =
    panPreset >= 32 || zoomDeltaPreset >= 0.095
      ? 2.1
      : panPreset <= 16 || zoomDeltaPreset <= 0.065
      ? 0.45
      : 1;
  // zoompan의 x/y는 정수 좌표로 처리되어 지터가 생기기 쉬움.
  // 알려진 우회: 사전 업스케일(오버샘플링) + x/y 정수화(trunc)로 반올림 떨림 완화.
  const supersample = tierFactor <= 0.5 ? 6 : tierFactor >= 2 ? 4 : 5;
  const upscaleW = Math.round(width * supersample);
  const upscaleH = Math.round(height * supersample);

  // ── 씬 길이에 관계없이 처음~끝까지 애니메이션이 진행되도록 sqrt 스케일링 ──
  // 짧은 씬(~4s 이하): 현재와 비슷한 체감 속도
  // 긴 씬: 느려지지만 끊김 없이 끝까지 진행 (멈추지 않음)
  const refDur = 4;
  const zoomSpeedPerSec = 0.006 * tierFactor;
  const panSpeedPxPerSec = 2.8 * tierFactor;
  const refZoomDelta = zoomSpeedPerSec * refDur;
  const refPanDist = panSpeedPxPerSec * refDur;
  const sqrtScale = Math.sqrt(d / refDur);

  // zoompan 기준:
  // centerX/Y = (iw - iw/zoom)/2 / (ih - ih/zoom)/2
  let zExpr = `${baseScale}`;
  let xExpr = "(iw-iw/zoom)/2";
  let yExpr = "(ih-ih/zoom)/2";
  const panDistance = refPanDist * sqrtScale;
  // 팬 거리는 웹 체감(px) 기준으로 계산하고, 내부 좌표계(고해상도)로 변환해 계단 현상 완화
  const panExpr = `${(panDistance * supersample).toFixed(3)}*${p}`;
  const zoomTotalDelta = refZoomDelta * sqrtScale;

  switch (animationType) {
    case "zoom-in":
      {
        const start = clamp(zoomStartPreset, 1.02, 1.18);
        zExpr = `${start.toFixed(5)}+${zoomTotalDelta.toFixed(5)}*${p}`;
      }
      break;
    case "zoom-out":
      {
        const end = clamp(zoomStartPreset, 1.0, 1.14);
        const start = end + zoomTotalDelta;
        zExpr = `${start.toFixed(5)}-${zoomTotalDelta.toFixed(5)}*${p}`;
      }
      break;
    case "move-left":
      zExpr = `${clamp(zoomStartPreset, 1.02, 1.18).toFixed(5)}`;
      xExpr = `(iw-iw/zoom)/2-${panExpr}`;
      break;
    case "move-right":
      zExpr = `${clamp(zoomStartPreset, 1.02, 1.18).toFixed(5)}`;
      xExpr = `(iw-iw/zoom)/2+${panExpr}`;
      break;
    case "move-up":
      zExpr = `${clamp(zoomStartPreset, 1.02, 1.18).toFixed(5)}`;
      yExpr = `(ih-ih/zoom)/2-${panExpr}`;
      break;
    case "move-down":
      zExpr = `${clamp(zoomStartPreset, 1.02, 1.18).toFixed(5)}`;
      yExpr = `(ih-ih/zoom)/2+${panExpr}`;
      break;
    case "none":
      // 애니메이션 없음: zoompan 건너뛰고 단순 scale+loop 사용
      return `[${inputIndex}:v]scale=${width}:${height}:force_original_aspect_ratio=increase:flags=bilinear,crop=${width}:${height},loop=loop=${frameCount}:size=1:start=0,trim=duration=${d.toFixed(3)},setpts=PTS-STARTPTS,fps=${fps},format=yuv420p,setsar=1[v${inputIndex}]`;

    default:
      {
        const start = clamp(zoomStartPreset, 1.02, 1.18);
        zExpr = `${start.toFixed(5)}+${zoomTotalDelta.toFixed(5)}*${p}`;
      }
      break;
  }

  const xFinal = `trunc(${xExpr})`;
  const yFinal = `trunc(${yExpr})`;

  return `[${inputIndex}:v]scale=${upscaleW}:${upscaleH}:force_original_aspect_ratio=increase:flags=bilinear,zoompan=z='${zExpr}':x='${xFinal}':y='${yFinal}':d=${frameCount}:s=${width}x${height}:fps=${fps},trim=duration=${d.toFixed(3)},setpts=PTS-STARTPTS,format=yuv420p,setsar=1[v${inputIndex}]`;
}

function resolveVoiceSource(job: BridgeJob): string | null {
  const audio = Array.isArray(job?.job?.timeline?.audio) ? job.job!.timeline!.audio! : [];
  const voice = audio.find((a) => a?.role === "voice" && (a?.filePath || a?.url));
  if (!voice) return null;
  const src = String(voice.filePath || voice.url || "").trim();
  return src || null;
}

function resolveBgmTrack(job: BridgeJob): { src: string; volume: number; fadeInSec: number; fadeOutSec: number } | null {
  const audio = Array.isArray(job?.job?.timeline?.audio) ? job.job!.timeline!.audio! : [];
  const bgm = audio.find((a) => a?.role === "bgm" && (a?.filePath || a?.url));
  if (!bgm) return null;
  const src = String(bgm.filePath || bgm.url || "").trim();
  if (!src) return null;
  const volumePercent = Number(bgm.volume ?? 10);
  const fadeInSec = Number(bgm.fadeInSec ?? 0.8);
  const fadeOutSec = Number(bgm.fadeOutSec ?? 0.8);
  return {
    src,
    volume: clamp(Number.isFinite(volumePercent) ? volumePercent / 100 : 0.1, 0, 1),
    fadeInSec: clamp(Number.isFinite(fadeInSec) ? fadeInSec : 0.8, 0, 20),
    fadeOutSec: clamp(Number.isFinite(fadeOutSec) ? fadeOutSec : 0.8, 0, 20),
  };
}

async function runFfmpegFromPrimaryMedia(params: {
  ffmpegPath: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  outputPath: string;
  media: { kind: "image" | "video"; src: string };
  voiceSrc: string | null;
  bgm: { src: string; volume: number; fadeInSec: number; fadeOutSec: number } | null;
  /** 자막 ASS 파일 경로 (제공 시 싱글패스로 자막 burn-in) */
  subtitleAssPath?: string;
}) {
  const { ffmpegPath, durationSec, width, height, fps, outputPath, media, voiceSrc, bgm, subtitleAssPath } = params;

  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await fs.unlink(outputPath);
  } catch {
    // ignore
  }

  let filter = `scale=${width}:${height}:force_original_aspect_ratio=increase,crop=${width}:${height},fps=${fps}`;
  if (subtitleAssPath) {
    const fontsDir = getBundledFontsDir();
    const fontsDirPart = fontsDir ? `:fontsdir='${escapeSubtitleFilterPath(fontsDir)}'` : "";
    filter += `,subtitles='${escapeSubtitleFilterPath(subtitleAssPath)}':charenc=UTF-8${fontsDirPart}`;
  }
  const args: string[] = ["-y"];

  if (media.kind === "image") {
    args.push("-loop", "1", "-i", media.src);
  } else {
    args.push("-i", media.src);
  }

  if (voiceSrc) {
    args.push("-i", voiceSrc);
  } else {
    args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  }
  if (bgm?.src) {
    args.push("-stream_loop", "-1", "-i", bgm.src);
  }

  const commonArgs = [
    "-t", String(durationSec),
    "-vf", filter,
    "-map", "0:v:0",
    ...getVideoEncoderArgs(),
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    outputPath,
  ];

  if (bgm?.src) {
    const fadeOutStart = Math.max(0, durationSec - bgm.fadeOutSec);
    const audioFilter = [
      `[1:a]atrim=0:${durationSec},asetpts=N/SR/TB[voice]`,
      `[2:a]atrim=0:${durationSec},asetpts=N/SR/TB,volume=${bgm.volume.toFixed(3)},afade=t=in:st=0:d=${bgm.fadeInSec.toFixed(2)},afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${bgm.fadeOutSec.toFixed(2)}[bgm]`,
      `[voice][bgm]amix=inputs=2:duration=first:dropout_transition=0[aout]`,
    ].join(";");
    args.push(
      "-filter_complex", audioFilter,
      "-map", "[aout]",
      ...commonArgs
    );
  } else {
    args.push(
      "-map", "1:a:0",
      ...commonArgs
    );
  }

  process.send?.({
    type: "progress",
    progress: 12,
    phase: "prepare",
    message: "영상 렌더링을 시작합니다...",
  });
  await runFfmpegProcessWithUiProgress({ ffmpegPath, args, durationSec, initialProgress: 12 });
}

async function runFfmpegImageTimelineConcat(params: {
  ffmpegPath: string;
  durationSec: number;
  width: number;
  height: number;
  fps: number;
  outputPath: string;
  media: Array<{ sceneId: string; src: string; startTime: number; endTime: number }>;
  voiceSrc: string | null;
  animationByScene: Map<string, ResolvedAnimation>;
  bgm: { src: string; volume: number; fadeInSec: number; fadeOutSec: number } | null;
  /** 자막 ASS 파일 경로 (제공 시 싱글패스로 자막 burn-in) */
  subtitleAssPath?: string;
}) {
  const { ffmpegPath, durationSec, width, height, fps, outputPath, media, voiceSrc, animationByScene, bgm, subtitleAssPath } = params;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  try {
    await fs.unlink(outputPath);
  } catch {
    // ignore
  }

  const normalized = media.map((m, idx) => {
    const nextStart = idx < media.length - 1 ? media[idx + 1].startTime : durationSec;
    const rawDuration =
      m.endTime > m.startTime
        ? m.endTime - m.startTime
        : nextStart > m.startTime
        ? nextStart - m.startTime
        : 2;
    return {
      src: m.src,
      duration: clamp(rawDuration, 0.2, Math.max(0.2, durationSec || 600)),
    };
  });

  const args: string[] = ["-y"];
  for (const item of normalized) {
    // zoompan이 각 이미지에서 필요한 프레임 수를 직접 생성하도록 단일 이미지 입력만 사용
    args.push("-i", item.src);
  }

  if (voiceSrc) {
    args.push("-i", voiceSrc);
  } else {
    args.push("-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000");
  }
  if (bgm?.src) {
    args.push("-stream_loop", "-1", "-i", bgm.src);
  }

  const videoFilterParts = normalized.map((item, idx) =>
    buildImageSegmentFilter({
      inputIndex: idx,
      width,
      height,
      fps,
      duration: item.duration,
      animation: animationByScene.get(media[idx]?.sceneId || "") || null,
    })
  );
  const concatInputs = normalized.map((_, idx) => `[v${idx}]`).join("");
  // 미리보기 스냅샷용 split: [vout_raw] → [vout] (메인) + [thumb_pre] → scale+fps → [thumb]
  const thumbW = Math.min(360, width);
  const snapshotPath = path.join(path.dirname(outputPath), `.crafly-thumb-${Date.now()}.jpg`);

  // 자막 ASS가 제공된 경우: concat → subtitles → split (싱글패스)
  // 없으면 기존대로: concat → split
  let subtitleChain = "";
  const concatOutLabel = subtitleAssPath ? "vout_pre_sub" : "vout_raw";
  if (subtitleAssPath) {
    const fontsDir = getBundledFontsDir();
    const fontsDirPart = fontsDir ? `:fontsdir='${escapeSubtitleFilterPath(fontsDir)}'` : "";
    subtitleChain = `;[vout_pre_sub]subtitles='${escapeSubtitleFilterPath(subtitleAssPath)}':charenc=UTF-8${fontsDirPart}[vout_raw]`;
  }
  const videoConcat = `${videoFilterParts.join(";")};${concatInputs}concat=n=${normalized.length}:v=1:a=0[${concatOutLabel}]${subtitleChain};[vout_raw]split=2[vout][thumb_pre];[thumb_pre]scale=${thumbW}:-2,fps=fps=1[thumb]`;
  const audioInputIndex = normalized.length;
  let filterComplex = videoConcat;

  const commonOutArgs = [
    "-map", "[vout]",
    "-t", String(durationSec),
    ...getVideoEncoderArgs(),
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", "192k",
    "-shortest",
    outputPath,
    // 썸네일 출력 (최신 프레임 1장을 계속 덮어쓰기)
    "-map", "[thumb]",
    "-f", "image2",
    "-update", "1",
    "-q:v", "8",
    snapshotPath,
  ];

  if (bgm?.src) {
    const bgmIndex = audioInputIndex + 1;
    const fadeOutStart = Math.max(0, durationSec - bgm.fadeOutSec);
    filterComplex += `;[${audioInputIndex}:a]atrim=0:${durationSec},asetpts=N/SR/TB[voice];`;
    filterComplex += `[${bgmIndex}:a]atrim=0:${durationSec},asetpts=N/SR/TB,volume=${bgm.volume.toFixed(3)},afade=t=in:st=0:d=${bgm.fadeInSec.toFixed(2)},afade=t=out:st=${fadeOutStart.toFixed(2)}:d=${bgm.fadeOutSec.toFixed(2)}[bgm];`;
    filterComplex += `[voice][bgm]amix=inputs=2:duration=first:dropout_transition=0[aout]`;
    args.push(
      "-filter_complex", filterComplex,
      "-map", "[aout]",
      ...commonOutArgs
    );
  } else {
    args.push(
      "-filter_complex", filterComplex,
      "-map", `${audioInputIndex}:a:0`,
      ...commonOutArgs
    );
  }

  process.send?.({
    type: "progress",
    progress: 12,
    phase: "prepare",
    message: subtitleAssPath
      ? "영상 애니메이션과 자막을 적용하고 있어요..."
      : "영상 애니메이션을 적용하고 있어요...",
  });

  // 장면별 누적 종료 시간 계산 (장면 카운트 표시용)
  let cumTime = 0;
  const sceneCumulativeEnds = normalized.map((item) => {
    cumTime += item.duration;
    return cumTime;
  });

  await runFfmpegProcessWithUiProgress({
    ffmpegPath,
    args,
    durationSec,
    initialProgress: 12,
    snapshotPath,
    sceneCumulativeEnds,
  });
}

async function burnInSubtitlesIfAny(params: {
  ffmpegPath: string;
  inputPath: string;
  outputPath: string;
  durationSec: number;
  job: BridgeJob;
  jobName: string;
}) {
  const { ffmpegPath, inputPath, outputPath, durationSec, job, jobName } = params;
  const subtitles = getSubtitleEntries(job);
  if (subtitles.length === 0) return;

  const { width, height } = parseVideoSpec(job);
  const assPath = await writeTempAss(subtitles, jobName, width, height);
  const tempOutput = `${outputPath}.subpass.mp4`;
  const fontsDir = getBundledFontsDir();
  const fontsDirPart = fontsDir ? `:fontsdir='${escapeSubtitleFilterPath(fontsDir)}'` : "";
  const subtitleFilter = `subtitles='${escapeSubtitleFilterPath(assPath)}':charenc=UTF-8${fontsDirPart}`;

  process.send?.({
    type: "progress",
    progress: 93,
    phase: "mux",
    message: `자막을 넣고 있어요... (${subtitles.length}개)`,
  });

  try {
    await fs.unlink(tempOutput).catch(() => undefined);
    // 자막 burn-in에도 미리보기 스냅샷 추가
    const thumbW = Math.min(360, width);
    const snapshotPath = path.join(path.dirname(outputPath), `.crafly-subthumb-${Date.now()}.jpg`);
    const subFilterComplex = `[0:v]${subtitleFilter},split=2[sv][sthumb_pre];[sthumb_pre]scale=${thumbW}:-2,fps=fps=1[sthumb]`;
    const args = [
      "-y",
      "-i", inputPath,
      "-filter_complex", subFilterComplex,
      "-map", "[sv]",
      ...getVideoEncoderArgs(),
      "-pix_fmt", "yuv420p",
      "-map", "0:a?",
      "-c:a", "copy",
      tempOutput,
      "-map", "[sthumb]",
      "-f", "image2",
      "-update", "1",
      "-q:v", "8",
      snapshotPath,
    ];

    await runFfmpegProcessWithUiProgress({
      ffmpegPath,
      args,
      durationSec,
      initialProgress: 93,
      snapshotPath,
    });

    await fs.rename(tempOutput, outputPath);
  } finally {
    await fs.unlink(assPath).catch(() => undefined);
    await fs.unlink(tempOutput).catch(() => undefined);
  }
}

async function main() {
  const jobPath = process.env.CRAFTLY_JOB_PATH || "";
  const outputPath = process.env.CRAFTLY_OUTPUT_PATH || "";
  const ffmpegPath = process.env.CRAFTLY_FFMPEG_PATH || "";
  const jobName = process.env.CRAFTLY_JOB_NAME || path.basename(jobPath || "job");

  if (!jobPath || !outputPath) {
    process.send?.({ type: "error", phase: "error", progress: 0, message: "Missing worker env (job/output path)" });
    process.exit(1);
    return;
  }

  const renderedBaseOutputPath = outputPath;

  try {
    await fs.access(jobPath);
  } catch {
    process.send?.({ type: "error", phase: "error", progress: 0, message: `Job file not found: ${jobPath}` });
    process.exit(1);
    return;
  }

  process.send?.({ type: "progress", progress: 4, phase: "prepare", message: "작업 정보를 읽고 있어요..." });

  let job: BridgeJob;
  try {
    const raw = await fs.readFile(jobPath, "utf8");
    job = JSON.parse(raw) as BridgeJob;
  } catch (error) {
    process.send?.({ type: "error", phase: "error", progress: 0, message: `Job parse failed: ${error instanceof Error ? error.message : String(error)}` });
    process.exit(1);
    return;
  }

  const durationSec = parseDurationSeconds(job);
  const { width, height, fps } = parseVideoSpec(job);
  const timelineMedia = resolveTimelineMedia(job);
  const animationByScene = resolveAnimationByScene(job);
  const primaryMedia = resolveMediaSource(job);
  const voiceSrc = resolveVoiceSource(job);
  const bgm = resolveBgmTrack(job);

  process.send?.({
    type: "progress",
    progress: 9,
    phase: "prepare",
    message: "렌더링 엔진을 준비하고 있어요...",
  });

  if (!ffmpegPath || !fssync.existsSync(ffmpegPath)) {
    await fs.writeFile(
      `${outputPath}.crafly-render-stub.txt`,
      `FFmpeg bundle missing.\nJob: ${jobPath}\nExpected output: ${outputPath}\n`,
      "utf8"
    );
    process.send?.({ type: "error", phase: "error", progress: 10, message: "번들 FFmpeg를 찾지 못했습니다." });
    process.exit(1);
    return;
  }

  // 자막이 있으면 ASS 파일을 미리 생성 (싱글패스 렌더링에 사용)
  const subtitleEntries = getSubtitleEntries(job);
  let subtitleAssPath: string | undefined;
  let subtitlesBurnedIn = false;
  if (subtitleEntries.length > 0) {
    subtitleAssPath = await writeTempAss(subtitleEntries, jobName, width, height);
  }

  try {
    const imageTimeline = timelineMedia.filter((m) => m.kind === "image");
    const canRunImageTimeline =
      timelineMedia.length >= 2 &&
      imageTimeline.length === timelineMedia.length;

    if (canRunImageTimeline) {
      process.send?.({
        type: "progress",
        progress: 11,
        phase: "prepare",
        message: `이미지 ${timelineMedia.length}장으로 영상 애니메이션을 적용하고 있어요...`,
      });
      await runFfmpegImageTimelineConcat({
        ffmpegPath,
        durationSec,
        width,
        height,
        fps,
        outputPath,
        media: imageTimeline.map((m) => ({
          sceneId: m.sceneId,
          src: m.src,
          startTime: m.startTime,
          endTime: m.endTime,
        })),
        voiceSrc,
        animationByScene,
        bgm,
        subtitleAssPath,
      });
      subtitlesBurnedIn = !!subtitleAssPath;
    } else if (primaryMedia) {
      process.send?.({
        type: "progress",
        progress: 11,
        phase: "prepare",
        message: "소스 영상을 처리하고 있어요...",
      });
      await runFfmpegFromPrimaryMedia({
        ffmpegPath,
        durationSec,
        width,
        height,
        fps,
        outputPath,
        media: primaryMedia,
        voiceSrc,
        bgm,
        subtitleAssPath,
      });
      subtitlesBurnedIn = !!subtitleAssPath;
    } else {
      process.send?.({ type: "progress", progress: 11, phase: "prepare", message: "기본 영상으로 대체하고 있어요..." });
      await runFfmpegPlaceholder({
        ffmpegPath,
        durationSec,
        width,
        height,
        fps,
        outputPath,
        jobName,
      });
    }
  } catch (error) {
    const firstErrorMessage = error instanceof Error ? error.message : String(error);
    const imageTimeline = timelineMedia.filter((m) => m.kind === "image");
    const canRunImageTimeline =
      timelineMedia.length >= 2 &&
      imageTimeline.length === timelineMedia.length;

    // 오디오 접근권한 실패(401 등) 포함, 첫 시도 실패 시 영상만으로 1회 재시도
    try {
      process.send?.({
        type: "progress",
        progress: 14,
        phase: "prepare",
        message: "오디오 없이 다시 시도하고 있어요...",
      });

      if (canRunImageTimeline) {
        await runFfmpegImageTimelineConcat({
          ffmpegPath,
          durationSec,
          width,
          height,
          fps,
          outputPath,
          media: imageTimeline.map((m) => ({
            sceneId: m.sceneId,
            src: m.src,
            startTime: m.startTime,
            endTime: m.endTime,
          })),
          voiceSrc: null,
          animationByScene,
          bgm: null,
          subtitleAssPath,
        });
        subtitlesBurnedIn = !!subtitleAssPath;
      } else if (primaryMedia) {
        await runFfmpegFromPrimaryMedia({
          ffmpegPath,
          durationSec,
          width,
          height,
          fps,
          outputPath,
          media: primaryMedia,
          voiceSrc: null,
          bgm: null,
          subtitleAssPath,
        });
        subtitlesBurnedIn = !!subtitleAssPath;
      } else {
        throw error;
      }
    } catch (retryError) {
      process.send?.({
        type: "progress",
        progress: 14,
        phase: "prepare",
        message: "기본 영상으로 대체하고 있어요...",
      });
      await runFfmpegPlaceholder({
        ffmpegPath,
        durationSec,
        width,
        height,
        fps,
        outputPath,
        jobName,
      });
    }
  }

  // 싱글패스로 자막이 이미 burn-in된 경우 별도 자막 패스 건너뜀
  if (!subtitlesBurnedIn) {
    try {
      await burnInSubtitlesIfAny({
        ffmpegPath,
        inputPath: renderedBaseOutputPath,
        outputPath,
        durationSec,
        job,
        jobName,
      });
    } catch (subtitleError) {
      process.send?.({
        type: "progress",
        progress: 96,
        phase: "mux",
        message: "자막 적용을 건너뛰었어요 (원본 영상 유지)",
      });
    }
  }

  // 미리 생성한 ASS 파일 정리
  if (subtitleAssPath) {
    await fs.unlink(subtitleAssPath).catch(() => undefined);
  }

  process.send?.({ type: "done", outputPath, ffmpegPath: ffmpegPath || null });
  process.exit(0);
}

main().catch((error) => {
  process.send?.({ type: "error", phase: "error", progress: 0, message: error instanceof Error ? error.message : String(error) });
  process.exit(1);
});
