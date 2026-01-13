# 배포 가이드

## 빌드 완료 ✅
빌드 파일이 `dist` 폴더에 생성되었습니다.

## 배포 방법

### 방법 1: Vercel 웹사이트 (가장 간단)
1. https://vercel.com 접속
2. GitHub 계정으로 로그인
3. "Add New Project" 클릭
4. GitHub 리포지토리 연결 또는 `dist` 폴더 드래그 앤 드롭
5. 배포 완료!

### 방법 2: Vercel CLI
```bash
cd C:\Users\openbusai\racingdraw\RacingDraw
npx vercel login
npx vercel --prod
```

### 방법 3: Netlify
1. https://app.netlify.com 접속
2. "Add new site" → "Deploy manually"
3. `dist` 폴더를 드래그 앤 드롭
4. 배포 완료!

### 방법 4: GitHub Pages
1. GitHub 리포지토리 Settings → Pages
2. Source를 "GitHub Actions"로 설정
3. `.github/workflows/deploy.yml` 파일 생성 (아래 참고)

## 빌드 파일 위치
- `dist/index.html`
- `dist/assets/` (CSS, JS 파일)
