import { useEffect, useMemo, useRef, useState } from "react";


/** 🏇 경마 레이스 랜덤 추첨기 (Canvas)
 *  - 20초 레이스 + 막판 슬로모(0.6x)
 *  - 앞서거니 뒤서거니(러버밴딩↑, 노이즈↑, 스퍼트/비틀, 드래프팅)
 *  - 실시간 중계 패널(TOP3/격차/미니바/타이머/LIVE)
 *  - 녹화(WebM) 자동 저장(옵션)
 *  - 결승 후 1~3위 중앙 표기 + 폭죽(5초)
 */

type Runner = {
  name: string;
  lane: number;
  x: number; // 0..1 진행도
  v: number; // 진행률/초
  fatigue: number;
  burstsLeft: number;
  nextBurstAt: number;
  color: string;
  finishedAt?: number; // 초
  event?: { type: "sprint" | "stumble"; until: number };
  lastEventAt?: number;
  // 동순위 방지용 정렬 편향(아주 작음, 화면 위치엔 영향 X)
  tieBias: number;
};

type Phase = "idle" | "race" | "celebrate";

const COLORS = [
  "#ffffff", "#ffd700", "#00ffff", "#ff69b4", "#7fffd4",
  "#ffa500", "#adff2f", "#dda0dd", "#87cefa", "#90ee90",
];

const clamp = (n: number, a: number, b: number) => Math.min(Math.max(n, a), b);
const rand = (a = 0, b = 1) => a + Math.random() * (b - a);
const seededRandom = (seed: number) => {
  let t = seed >>> 0;
  return () => {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
};

export default function RacingDraw() {
  // 참가자
  const [rawList, setRawList] = useState(`1번말 삼식이
2번말 춘삼이
3번말 막둥이
4번말 돌쇠
5번말 복실이
6번말 말순이
`);
  const participants = useMemo(() => {
    const tokens = rawList.split(/[\n,;]+/).map(s => s.trim()).filter(Boolean);
    return Array.from(new Set(tokens));
  }, [rawList]);

  // 설정
  const [numWinners, setNumWinners] = useState(3);
  const [seedInput, setSeedInput] = useState("");
  const [recordEnabled, setRecordEnabled] = useState(true);

  // 상태
  const [timeStr, setTimeStr] = useState("00.0");
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);
  // ✅ 전체 순위 결과(완주자는 기록, 미완주자는 진행도) 추가
  const [allResults, setAllResults] = useState<Array<{ name: string; time?: number; progress: number }>>([]);

  // 캔버스/애니메이션
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const offscreenRef = useRef<HTMLCanvasElement | null>(null);
  const reqRef = useRef<number | null>(null);

  // 레이스 컨트롤
  const phaseRef = useRef<Phase>("idle");
  const startTsRef = useRef<number>(0);
  const raceTimeRef = useRef<number>(0);
  const duration = 20; // 초
  const slowMoFactor = 0.6;
  const slowMoTriggeredRef = useRef(false);

  // 녹화
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<BlobPart[]>([]);

  // 데이터
  const runnersRef = useRef<Runner[]>([]);
  const prngRef = useRef<() => number>(() => Math.random());

  // 축하(폭죽)
  const celebrationEndRef = useRef<number>(0);
  const fireworksRef = useRef<Array<{ x: number; y: number; vx: number; vy: number; life: number; color: string }>>([]);

  // 최종 우승자 텍스트
  const winnersRef = useRef<string[]>([]);

  // 초기화
  const initRace = () => {
    const prng = seedInput
      ? seededRandom(Array.from(seedInput).reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 0))
      : Math.random;
    prngRef.current = prng;

    const shuffled = [...participants].sort(() => prng() - 0.5);
    const runners: Runner[] = shuffled.map((name, i) => ({
      name,
      lane: i,
      x: 0,
      v: 0,
      fatigue: rand(0.02, 0.04),
      burstsLeft: Math.floor(prng() * 2) + 2,  // 2~3회
      nextBurstAt: 0.15 + prng() * 0.6,        // 0.15~0.75
      color: COLORS[i % COLORS.length],
      event: undefined,
      lastEventAt: 0,
      tieBias: prng() * 1e-6 + i * 1e-6, // 각자 고유 미세값
    }));

    runnersRef.current = runners;
    winnersRef.current = [];
    setAllResults([]); // ✅ 결과 초기화
    raceTimeRef.current = 0;
    setTimeStr("00.0");
    slowMoTriggeredRef.current = false;
  };

  // 녹화 제어
  const startRecording = () => {
    if (!recordEnabled) return;
    const canvas = canvasRef.current!;
    const stream = (canvas as any).captureStream?.(60);
    if (!stream) return;

    let mime = "video/webm;codecs=vp9";
    if (!("MediaRecorder" in window) || !MediaRecorder.isTypeSupported?.(mime)) {
      mime = "video/webm;codecs=vp8";
      if (!MediaRecorder.isTypeSupported?.(mime)) mime = "video/webm";
    }
    const mr = new MediaRecorder(stream, { mimeType: mime });
    recordedChunksRef.current = [];
    mr.ondataavailable = (e) => { if (e.data && e.data.size > 0) recordedChunksRef.current.push(e.data); };
    mr.onstop = () => {
      const blob = new Blob(recordedChunksRef.current, { type: mr.mimeType });
      const url = URL.createObjectURL(blob);
      setDownloadUrl(prev => { if (prev) URL.revokeObjectURL(prev); return url; });
      const a = document.createElement("a");
      a.href = url;
      a.download = `racedraw-${Date.now()}.webm`;
      a.click();
      a.remove();
    };
    mediaRecorderRef.current = mr;
    mr.start();
  };
  const stopRecording = () => {
    const mr = mediaRecorderRef.current;
    if (mr && mr.state !== "inactive") mr.stop();
    mediaRecorderRef.current = null;
  };

  // 시작/종료
  const startRace = () => {
    if (!participants.length) return alert("참가자를 입력하세요.");
    initRace();
    phaseRef.current = "race";
    startRecording();
    startTsRef.current = performance.now();
    reqRef.current = requestAnimationFrame(tick);
  };

  const toCelebrate = (now: number) => {
    // 최종 순위 계산
    const arr = [...runnersRef.current];
    const finished = arr.filter(r => r.finishedAt !== undefined).sort((a, b) => (a.finishedAt! - b.finishedAt!));
    const rest = arr.filter(r => r.finishedAt === undefined).sort((a, b) => (b.x + b.tieBias) - (a.x + a.tieBias));

    const order = [...finished.map(r => r.name), ...rest.map(r => r.name)];
    winnersRef.current = order.slice(0, Math.min(numWinners, order.length));

    // ✅ 전체 결과 저장(완주자는 기록, 미완주자는 진행도)
    //    -> 완주 기록은 0.01초 단위로 반드시 증가하도록 보정
    let lastTime = -Infinity;
    const finishedResults = finished.map((r) => {
      // 소수 둘째 자리까지 반올림
      let t = Number((r.finishedAt ?? 0).toFixed(2));
      // 직전 기록과 같거나 더 빠르면 0.01s 만큼 밀어줌(동순위 방지)
      if (t <= lastTime) t = Number((lastTime + 0.01).toFixed(2));
      lastTime = t;
      return { name: r.name, time: t, progress: 1 };
    });

    const results = [
      ...finishedResults,
      ...rest.map(r => ({ name: r.name, progress: r.x })),
    ];
    setAllResults(results);

    // 폭죽 초기화
    fireworksRef.current = makeFireworks(6);
    celebrationEndRef.current = now + 5000; // 5초
    phaseRef.current = "celebrate";
    stopRecording(); // 녹화는 종료와 함께 마무리
  };

  const makeFireworks = (bursts: number) => {
    const out: Array<{ x: number; y: number; vx: number; vy: number; life: number; color: string }> = [];
    const colors = ["#ff4d4f", "#40c463", "#ffd700", "#60a5fa", "#f472b6", "#22d3ee", "#a78bfa", "#f97316"];
    for (let i = 0; i < bursts; i++) {
      const cx = 0.3 + Math.random() * 0.4; // 화면 중앙 부근
      const cy = 0.35 + Math.random() * 0.3;
      const count = 60 + Math.floor(Math.random() * 50);
      for (let j = 0; j < count; j++) {
        const ang = Math.random() * Math.PI * 2;
        const spd = 0.35 + Math.random() * 1.2;
        out.push({
          x: cx,
          y: cy,
          vx: Math.cos(ang) * spd,
          vy: Math.sin(ang) * spd,
          life: 1 + Math.random() * 1.2,
          color: colors[(i + j) % colors.length],
        });
      }
    }
    return out;
  };

  // 메인 루프
  const tick = (now: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    const phase = phaseRef.current;

    if (phase === "race") {
      // 시간
      const elapsed = (now - startTsRef.current) / 1000;
      let dt = raceTimeRef.current === 0 ? 0.016 : clamp(elapsed - raceTimeRef.current, 0.001, 0.05);

      // 슬로모 조건
      const lead = Math.max(...runnersRef.current.map(r => r.x));
      if (!slowMoTriggeredRef.current) {
        if (lead >= 0.9 || duration - elapsed <= 2) slowMoTriggeredRef.current = true;
      }
      if (slowMoTriggeredRef.current) dt *= slowMoFactor;

      raceTimeRef.current = elapsed;
      const nowLabel = elapsed.toFixed(1).padStart(4, "0");

      // 물리
      const maxX = lead;
      const base = 1 / duration;

      runnersRef.current.forEach(r => {
        if (r.finishedAt !== undefined) return;

        // 예약 버스트
        let burstBoost = 0;
        if (r.burstsLeft > 0 && r.x >= r.nextBurstAt) {
          burstBoost = rand(1.25, 1.7);
          r.burstsLeft -= 1;
          r.nextBurstAt = r.x + rand(0.12, 0.2);
        }

        const noise = rand(-0.008, 0.008);
        const myGap = maxX - r.x;
        const rubber = clamp(myGap * 0.5, 0, 0.18);     // 러버밴딩 강화
        const drafting = myGap > 0 && myGap < 0.03 ? 0.04 : 0;

        let targetV = base * (1 + rubber) + noise + drafting;
        if (burstBoost > 0) targetV *= burstBoost;
        targetV = clamp(targetV, 0, 0.28);

        // 관성 + 피로
        r.v += (targetV - r.v) * 0.45;
        r.v = Math.max(0, r.v - r.fatigue * dt * 0.15);

        // 랜덤 이벤트(2~4초 간격, 0.6초)
        if (!r.event && (raceTimeRef.current - (r.lastEventAt ?? 0) > rand(2, 4))) {
          const roll = Math.random();
          if (roll < 0.25) r.event = { type: "sprint", until: raceTimeRef.current + 0.6 };
          else if (roll < 0.40) r.event = { type: "stumble", until: raceTimeRef.current + 0.6 };
          if (r.event) r.lastEventAt = raceTimeRef.current;
        }
        if (r.event) {
          if (raceTimeRef.current < r.event.until) {
            if (r.event.type === "sprint") r.v *= 1.35;
            else r.v *= 0.7;
          } else r.event = undefined;
        }

        // 위치
        r.x += r.v * dt;
        if (r.x >= 1) { r.x = 1; r.finishedAt = elapsed + r.tieBias; }
      });

      // 그리기
      draw(false, nowLabel);

      // 종료 판정
      const orderNow = [...runnersRef.current].sort((a, b) => (b.x + b.tieBias) - (a.x + a.tieBias));
      const finishedCount = runnersRef.current.filter(r => r.finishedAt !== undefined).length;
      if ((orderNow[0].x >= 1 && finishedCount >= Math.min(numWinners, runnersRef.current.length)) || elapsed >= duration + 2) {
        draw(true, nowLabel);
        toCelebrate(now);
      }

      if (phaseRef.current !== "celebrate") {
        reqRef.current = requestAnimationFrame(tick);
      } else {
        reqRef.current = requestAnimationFrame(tick);
      }
      return;
    }

    if (phase === "celebrate") {
      // 폭죽 업데이트만
      draw(true, raceTimeRef.current.toFixed(1).padStart(4, "0"));
      const dpr = window.devicePixelRatio || 1;
      const w = canvas.width;
      const h = canvas.height;
      const ctx2 = canvas.getContext("2d")!;

      // 파티클 업데이트/렌더
      const arr = fireworksRef.current;
      const dt = 0.016;
      for (let i = arr.length - 1; i >= 0; i--) {
        const p = arr[i];
        p.vx *= 0.985; p.vy *= 0.985; // 감속
        p.vy += 0.08;                // 중력
        p.x += (p.vx * dt) / 2;      // 화면 비율 조정(대충)
        p.y += (p.vy * dt) / 2;
        p.life -= dt * 0.5;
        if (p.life <= 0) arr.splice(i, 1);
      }

      // 그리기
      ctx2.save();
      ctx2.globalCompositeOperation = "lighter";
      arr.forEach(p => {
        const x = p.x * w;
        const y = p.y * h;
        ctx2.beginPath();
        ctx2.arc(x, y, 2.5 * dpr, 0, Math.PI * 2);
        ctx2.fillStyle = p.color;
        ctx2.fill();
      });
      ctx2.restore();

      if (now < celebrationEndRef.current) {
        reqRef.current = requestAnimationFrame(tick);
      } else {
        phaseRef.current = "idle";
        // 마지막 한 프레임 정지화면 유지
      }
      return;
    }

    // idle
    draw();
  };

  // 렌더링
  const draw = (final = false, timeLabel?: string) => {
    const canvas = canvasRef.current!;
    const dpr = window.devicePixelRatio || 1;
    const width = Math.floor((canvas.clientWidth || 960) * dpr);
    const height = Math.floor((canvas.clientHeight || 520) * dpr);

    if (!offscreenRef.current) offscreenRef.current = document.createElement("canvas");
    const off = offscreenRef.current;
    if (off.width !== width || off.height !== height) { off.width = width; off.height = height; }
    const ctx = off.getContext("2d")!;
    ctx.clearRect(0, 0, width, height);

    // 배경
    ctx.fillStyle = "#101214";
    ctx.fillRect(0, 0, width, height);

    // 트랙
    const margin = 24 * dpr;
    const trackLeft = margin * 2.2;
    const trackRight = width - margin;
    const trackTop = margin * 2.2;
    const trackBottom = height - margin * 2.2;
    const trackWidth = trackRight - trackLeft;
    const lanes = Math.max(1, runnersRef.current.length);
    const laneGap = (trackBottom - trackTop) / lanes;

    // 제목
    ctx.fillStyle = "#ffffff";
    ctx.font = `${18 * dpr}px system-ui, Noto Sans KR, sans-serif`;
    ctx.fillText("🏇 경마 레이스 랜덤 추첨기", margin, margin * 1.2);

    // 결승선
    const finishX = trackRight;
    for (let y = trackTop; y < trackBottom; y += 10 * dpr) {
      ctx.fillStyle = (Math.floor((y / (10 * dpr)) % 2) === 0) ? "#ffffff" : "#000000";
      ctx.fillRect(finishX - 6 * dpr, y, 6 * dpr, 10 * dpr);
    }
    //ctx.fillStyle = "#ffffff";
    //ctx.fillText("FINISH", finishX - 64 * dpr, trackTop - 8 * dpr);

    // 각 레인
    const runners = runnersRef.current;
    runners.forEach((r, i) => {
      const y = trackTop + laneGap * i + laneGap * 0.5;

      // 레인 라인
      ctx.strokeStyle = "rgba(255,255,255,0.15)";
      ctx.lineWidth = 1 * dpr;
      ctx.beginPath(); ctx.moveTo(trackLeft, y + laneGap * 0.5); ctx.lineTo(trackRight, y + laneGap * 0.5); ctx.stroke();

      // 위치
      const x = trackLeft + r.x * trackWidth;

      // 말 & 이름
      ctx.textBaseline = "middle";
      ctx.font = `${Math.max(18, Math.min(28, laneGap * 0.5)) * dpr}px Apple Color Emoji, Noto Color Emoji, Segoe UI Emoji`;
      ctx.fillText("🏇", x, y);

      ctx.font = `${14 * dpr}px system-ui, Noto Sans KR, sans-serif`;
      ctx.fillStyle = r.color;
      ctx.fillText(` ${r.name}`, x + 18 * dpr, y);

      // 이벤트 라벨
      if (r.event && phaseRef.current === "race" && raceTimeRef.current < r.event.until) {
        ctx.font = `${12 * dpr}px system-ui, Noto Sans KR, sans-serif`;
        ctx.textAlign = "left"; ctx.textBaseline = "bottom";
        ctx.fillStyle = r.event.type === "sprint" ? "#22c55e" : "#f97316";
        ctx.fillText(r.event.type === "sprint" ? "스퍼트!" : "비틀!", x + 18 * dpr, y - 12 * dpr);
      }

      // 개인 미니 진행바
      const barW = 120 * dpr, barH = 6 * dpr;
      const barX = trackLeft - barW - 12 * dpr, barY = y - barH / 2;
      ctx.fillStyle = "rgba(255,255,255,0.12)"; ctx.fillRect(barX, barY, barW, barH);
      ctx.fillStyle = r.color; ctx.fillRect(barX, barY, barW * r.x, barH);

      // 레인 번호
      ctx.fillStyle = "rgba(255,255,255,0.6)";
      ctx.fillText(String(i + 1).padStart(2, "0"), barX - 28 * dpr, y);
    });

    // HUD(타이머 + LIVE)
    ctx.font = `${16 * dpr}px system-ui, Noto Sans KR, sans-serif`;
    ctx.fillStyle = "#ffffff";
    ctx.textAlign = "right";
    ctx.fillText(`⏱ ${(timeLabel ?? timeStr)}s`, trackRight, margin * 1.2);
    // LIVE 배지
    const liveW = 52 * dpr, liveH = 18 * dpr;
    const liveX = trackRight - liveW - 90 * dpr, liveY = margin * 0.4;
    if (phaseRef.current === "race") {
      ctx.fillStyle = "#ff3b30"; ctx.fillRect(liveX, liveY, liveW, liveH);
      ctx.fillStyle = "#ffffff"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillText("LIVE", liveX + liveW / 2, liveY + liveH / 2);
    }

    // 중계 패널 (매 프레임 계산)
    const panelW = 260 * dpr;
    const panelH = 110 * dpr;
    // 트랙 상단 중앙 배치
    const panelX = trackLeft + (trackWidth - panelW) / 2;
    const panelY = Math.max(margin * 0.8, trackTop - (panelH + 10 * dpr));
    // 배경을 조금 더 진하게 해서 트랙과 겹쳐도 가독성 확보
    ctx.fillStyle = "rgba(0,0,0,0.45)";

    ctx.strokeStyle = "rgba(255,255,255,0.2)"; ctx.strokeRect(panelX, panelY, panelW, panelH);
    ctx.textAlign = "left"; ctx.textBaseline = "alphabetic"; ctx.fillStyle = "#ffffff";
    ctx.font = `${14 * dpr}px system-ui, Noto Sans KR, sans-serif`;
    ctx.fillText("🎙 LIVE 중계 TOP 3", panelX + 10 * dpr, panelY + 20 * dpr);

    // tieBias를 더해 동순위 방지(화면 위치는 그대로 x를 사용)
    const sorted = [...runners].sort((a, b) => (b.x + b.tieBias) - (a.x + a.tieBias));
    const topNames = sorted.slice(0, 3).map(r => r.name);
    const gaps = [
      sorted.length > 1 ? sorted[0].x - sorted[1].x : 0,
      sorted.length > 2 ? sorted[1].x - sorted[2].x : 0,
    ];
    topNames.forEach((name, idx) => {
      const y = panelY + 40 * dpr + idx * 22 * dpr;
      const barW = (panelW - 20 * dpr) * 0.38;
      const gapVal = gaps[idx] ?? 0;

      ctx.fillStyle = COLORS[idx % COLORS.length];
      ctx.fillText(`${idx + 1}. ${name}`, panelX + 10 * dpr, y);

      ctx.fillStyle = "rgba(255,255,255,0.7)";
      ctx.fillText(`Δ ${(gapVal * 100).toFixed(1)}%p`, panelX + panelW - barW - 10 * dpr, y);

      ctx.fillStyle = "rgba(255,255,255,0.12)";
      ctx.fillRect(panelX + panelW - barW - 10 * dpr, y + 6 * dpr, barW, 6 * dpr);
      ctx.fillStyle = COLORS[idx % COLORS.length];
      ctx.fillRect(panelX + panelW - barW - 10 * dpr, y + 6 * dpr, clamp(barW * (1 - gapVal / 0.2), 0, barW), 6 * dpr);
    });

    // 결승/축하 오버레이
    if (final || phaseRef.current === "celebrate") {
      // 딤
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(0, 0, width, height);

      // 중앙에 1~3위 크게
      const winners = winnersRef.current;
      if (winners.length) {
        ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.font = `${36 * dpr}px bold system-ui, Noto Sans KR, sans-serif`;
        ctx.fillStyle = "#ffd700";
        ctx.fillText(`🏆 1위: ${winners[0]}`, width / 2, height * 0.44);
        if (winners[1]) {
          ctx.fillStyle = "#cbd5e1";
          ctx.fillText(`2위: ${winners[1]}`, width / 2, height * 0.52);
        }
        if (winners[2]) {
          ctx.fillStyle = "#94a3b8";
          ctx.fillText(`3위: ${winners[2]}`, width / 2, height * 0.60);
        }
      }
    }

    // 화면 출력
    const ctx2 = canvas.getContext("2d")!;
    if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
    ctx2.drawImage(off, 0, 0);
  };

  // 초기 렌더/정리
  useEffect(() => {
    initRace();
    const onResize = () => draw();
    window.addEventListener("resize", onResize);
    draw();
    return () => {
      if (reqRef.current) cancelAnimationFrame(reqRef.current);
      window.removeEventListener("resize", onResize);
      stopRecording();
      if (downloadUrl) URL.revokeObjectURL(downloadUrl);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ padding: 16, color: "black", fontFamily: "system-ui, Noto Sans KR, sans-serif" }}>
      <h2
        style={{
          margin: "0 0 8px",
          paddingLeft: "12px", // ← 왼쪽 여백 추가
          textAlign: "center", // ← 가운데 정렬
          whiteSpace: "nowrap", // ← 줄바꿈 방지
        }}
      >
        🏇 경마 레이스 랜덤 추첨기
      </h2>

      <div style={{ display: "grid", gridTemplateColumns: "320px 1fr", gap: 28, alignItems: "start" }}>
        {/* 좌측 패널 */}
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <label style={{ fontSize: 14, color: "black" }}>참가자 목록</label>
          <textarea
            value={rawList}
            onChange={(e) => setRawList(e.target.value)}
            rows={14}
            style={{
              width: "100%",
              background: "white",
              color: "black",
              border: "1px solid #222",
              borderRadius: 8,
              padding: 8,
              outline: "none",
              fontFamily: "inherit",
            }}
            placeholder={`이름을 줄바꿈으로 입력하거나,\nCSV로 붙여넣기 하세요.`}
          />

          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <div>
              <label style={{ fontSize: 13, color: "black" }}>당첨 인원</label>
              <input
                type="number"
                min={1}
                max={Math.max(1, participants.length)}
                value={numWinners}
                onChange={(e) => setNumWinners(Number(e.target.value))}
                style={{
                  width: "100%",
                  background: "#0d0f12",
                  color: "#e6e6e6",
                  border: "1px solid #222",
                  borderRadius: 8,
                  padding: 8,
                  outline: "none",
                }}
              />
            </div>
            <div>
              <label style={{ fontSize: 13, color: "black" }}>시드(선택)</label>
              <input
                type="text"
                value={seedInput}
                onChange={(e) => setSeedInput(e.target.value)}
                placeholder="예: 2025-08-10T09:00+09:00"
                style={{
                  width: "100%",
                  background: "#0d0f12",
                  color: "#e6e6e6",
                  border: "1px solid #222",
                  borderRadius: 8,
                  padding: 8,
                  outline: "none",
                }}
              />
            </div>
          </div>

          <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 13 }}>
            <input
              type="checkbox"
              checked={recordEnabled}
              onChange={(e) => setRecordEnabled(e.target.checked)}
            />
            레이스 녹화(WebM) 자동 저장
          </label>

          <div style={{ display: "flex", gap: 8, marginTop: 4 }}>
            <button
              onClick={startRace}
              style={{
                flex: 1,
                background: "#1f6feb",
                color: "white",
                border: "none",
                borderRadius: 8,
                padding: "10px 12px",
                cursor: "pointer",
              }}
            >
              ▶ 레이스 시작
            </button>
            <button
              onClick={() => {
                if (phaseRef.current === "race" && !confirm("레이스를 초기화할까요?")) return;
                if (downloadUrl) { URL.revokeObjectURL(downloadUrl); setDownloadUrl(null); }
                initRace(); phaseRef.current = "idle"; draw();
              }}
              style={{
                background: "#2b2f36",
                color: "white",
                border: "none",
                borderRadius: 8,
                padding: "10px 12px",
                cursor: "pointer",
              }}
            >
              ↻ 초기화
            </button>
          </div>

          {downloadUrl && (
            <a
              href={downloadUrl}
              download={`racedraw-${Date.now()}.webm`}
              style={{ fontSize: 13, marginTop: 6, color: "#a5d6ff" }}
            >
              ⬇ 녹화 다시 다운로드
            </a>
          )}

          {/* ✅ 전체 순위 결과 패널 */}
          {allResults.length > 0 && (
            <div
              style={{
                marginTop: 12,
                padding: 12,
                background: "#0d0f12",
                border: "1px solid #222",
                borderRadius: 8,
              }}
            >
              <div style={{ fontWeight: 700, marginBottom: 8, color: "#e6e6e6" }}>📋 전체 결과</div>
              <ol
                style={{
                  margin: 0,
                  paddingLeft: 18,
                  color: "#ffffff", // ← 숫자 색상 흰색으로 지정
                  listStyle: "decimal",
                }}
              >
                {allResults.map((r, idx) => (
                  <li key={idx} style={{ lineHeight: 1.6 }}>
                    <span>{r.name}</span>{" "}
                    <span style={{ color: "#9aa4b2", fontSize: 13 }}>
                      {r.time !== undefined
                        ? `— ${r.time.toFixed(2)}s`
                        : `— ${Math.round(r.progress * 100)}% 진행`}
                    </span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>

        {/* 우측 캔버스 */}
        <div
          style={{
            background: "#0b0d10",
            border: "1px solid #222",
            borderRadius: 12,
            position: "relative",
            minHeight: 420,
          }}
        >
          <canvas
            ref={canvasRef}
            style={{ width: "100%", height: 520, display: "block", borderRadius: 12 }}
          />
        </div>
      </div>
    </div>
  );
}
