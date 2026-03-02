# 앱 아이콘

- **icon.svg** – 앱 아이콘 소스 (Crafly 별 마크 + 다크 배경)
- 패키징용 PNG/ICO/ICNS는 이 SVG를 바탕으로 생성합니다.

## 생성 방법

**방법 1 (권장)** – 스크립트로 PNG 생성 후 패키징

```bash
npm install sharp --save-dev
npm run generate-icon
```

위 명령으로 `assets/icon.png`(512×512)가 생성됩니다.  
이후 `npm run pack:mac` / `npm run pack:win` 시 electron-builder가 이 PNG를 사용해 각 OS용 아이콘을 만듭니다.

**방법 2** – 수동 생성

- [CloudConvert](https://cloudconvert.com/svg-to-png) 등에서 `icon.svg`를 512×512 PNG로 내보내기 → `icon.png`로 저장
- (선택) Windows: `icon.ico`(256×256), macOS: `icon.icns`(1024×1024 포함) 수동 생성 가능

