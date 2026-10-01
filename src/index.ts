// ============================================================
// 고스톱 게임 서버 - src/index.ts
// ============================================================
// 룰 요약:
//  - 4인 플레이, 첫 게임은 무작위 순서
//  - 이긴 사람이 다음 게임 첫 순서(선)
//  - 마지막 1인은 광/쌍피 팔이 가능 (선 제외 나머지가 개당 500원 지불)
//  - 쩜당 500원, 첫뻑 1500원, 총통 10000원
//  - 쌍피: 보너스피 포함 2장, 난초동물도 쌍피로 간주
//  - 누적 금액 전체 공개 (제한 없음)
// ============================================================

import * as http from "http";
import * as crypto from "crypto";

// ──────────────────────────────────────────────
// 타입 정의
// ──────────────────────────────────────────────

type CardType = "gwang" | "yeol" | "tti" | "pi" | "ssangpi";

interface Card {
  id: string;
  month: number; // 1~12
  type: CardType;
  name: string;
  isBonusPi?: boolean;   // 보너스피(쌍피 포함 2장)
  isOrchidAnimal?: boolean; // 난초 동물 (쌍피 취급)
}

type PlayerStatus = "playing" | "dead" | "spectating";

interface Player {
  id: string;
  name: string;
  hand: Card[];
  captured: Card[];
  score: number;        // 현재 게임 점수(쩜)
  balance: number;      // 누적 금액 (원)
  status: PlayerStatus;
  isReady: boolean;
}

type GamePhase =
  | "waiting"       // 4명 접속 대기
  | "selling"       // 마지막 탈락자 광/쌍피 팔이
  | "ordering"      // 순서 결정 (첫 게임만)
  | "playing"       // 게임 진행 중
  | "roundEnd"      // 한 라운드 종료 / 정산
  | "gameEnd";      // 전체 게임 종료

interface SellItem {
  card: Card;
  pricePerItem: number; // 500원 고정
}

interface GameState {
  phase: GamePhase;
  players: Player[];           // index = 자리번호
  turnOrder: string[];         // 이번 게임 플레이 순서 (player id)
  currentTurnIndex: number;    // turnOrder 내 현재 인덱스
  deck: Card[];
  floorCards: Card[];
  roundNumber: number;
  sellQueue: SellItem[];       // 팔이 대기 목록
  sellerPlayerId: string | null; // 팔이 진행 중인 플레이어
  log: string[];               // 게임 로그
}

// ──────────────────────────────────────────────
// 카드 덱 생성
// ──────────────────────────────────────────────

function buildDeck(): Card[] {
  const deck: Card[] = [];

  // 월별 카드 구성
  // gwang(광): 1,3,8,11,12월  yeol(열): 나머지 10짜리  tti(띠): 모든 월  pi(피): 모든 월
  const months: {
    month: number;
    gwang?: boolean;
    yeol?: boolean;
    tti: number;
    pi: number;
    ssangpi?: boolean;       // 해당 월 피에 쌍피(보너스피) 포함
    orchidAnimal?: boolean;  // 난초 동물 여부 (6월 동물)
  }[] = [
    { month: 1,  gwang: true,  tti: 1, pi: 2 },
    { month: 2,  tti: 1, pi: 2, ssangpi: true },          // 2월 쌍피 보너스피
    { month: 3,  gwang: true,  tti: 1, pi: 2 },
    { month: 4,  tti: 1, pi: 2 },
    { month: 5,  tti: 1, pi: 2 },
    { month: 6,  tti: 1, pi: 1, orchidAnimal: true },     // 난초 동물(쌍피 취급)
    { month: 7,  tti: 1, pi: 2 },
    { month: 8,  gwang: true, yeol: true, tti: 1, pi: 1 },// 8월: 광+열+띠+피1
    { month: 9,  tti: 1, pi: 2 },
    { month: 10, yeol: true, tti: 1, pi: 2 },
    { month: 11, gwang: true, tti: 1, pi: 2 },
    { month: 12, gwang: true, tti: 1, pi: 1 },            // 비 광
  ];

  for (const m of months) {
    const base = `m${m.month}`;
    if (m.gwang) {
      deck.push({ id: `${base}_gwang`, month: m.month, type: "gwang", name: `${m.month}월 광` });
    }
    if (m.yeol) {
      deck.push({ id: `${base}_yeol`, month: m.month, type: "yeol", name: `${m.month}월 열` });
    }
    for (let i = 0; i < m.tti; i++) {
      deck.push({ id: `${base}_tti${i}`, month: m.month, type: "tti", name: `${m.month}월 띠` });
    }
    for (let i = 0; i < m.pi; i++) {
      if (m.ssangpi && i === m.pi - 1) {
        // 마지막 피가 쌍피(보너스피 2장짜리)
        deck.push({
          id: `${base}_ssangpi`,
          month: m.month,
          type: "ssangpi",
          name: `${m.month}월 쌍피`,
          isBonusPi: true,
        });
      } else if (m.orchidAnimal && i === 0) {
        // 난초 동물 = 쌍피 취급
        deck.push({
          id: `${base}_orchid`,
          month: m.month,
          type: "ssangpi",
          name: `${m.month}월 난초동물(쌍피)`,
          isOrchidAnimal: true,
        });
      } else {
        deck.push({ id: `${base}_pi${i}`, month: m.month, type: "pi", name: `${m.month}월 피` });
      }
    }
  }

  return deck;
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ──────────────────────────────────────────────
// 점수 계산
// ──────────────────────────────────────────────

function countPiScore(captured: Card[]): number {
  // 피 점수: 피 1장=1점, 쌍피(보너스피/난초동물)=2점
  // 기본 피가 9장 이상부터 1쩜, 이후 1장당 1쩜 추가
  let piCount = 0;
  for (const c of captured) {
    if (c.type === "pi") piCount += 1;
    else if (c.type === "ssangpi") piCount += 2;
  }
  const base = 9;
  return piCount >= base ? 1 + (piCount - base) : 0;
}

function countGwangScore(captured: Card[]): number {
  const gwangs = captured.filter((c) => c.type === "gwang").length;
  if (gwangs === 3) return 3; // 비 광 포함이면 2쩜
  if (gwangs === 4) return 4;
  if (gwangs === 5) return 15;
  return 0;
}

function countYeolScore(captured: Card[]): number {
  const yeols = captured.filter((c) => c.type === "yeol").length;
  if (yeols === 5) return 1;
  if (yeols === 6) return 2;
  if (yeols === 7) return 3;
  if (yeols === 8) return 4;
  if (yeols === 9) return 5;
  if (yeols >= 10) return 5 + (yeols - 10);
  return 0;
}

function countTtiScore(captured: Card[]): number {
  const ttis = captured.filter((c) => c.type === "tti").length;
  if (ttis === 5) return 1;
  if (ttis === 6) return 2;
  if (ttis === 7) return 3;
  if (ttis >= 8) return 3 + (ttis - 8);
  return 0;
}

function calculateScore(captured: Card[]): number {
  return (
    countGwangScore(captured) +
    countYeolScore(captured) +
    countTtiScore(captured) +
    countPiScore(captured)
  );
}

// ──────────────────────────────────────────────
// 게임 상태 관리
// ──────────────────────────────────────────────

const POINTS_PER_SCORE = 500;      // 쩜당 500원
const FIRST_BBUCK_PRICE = 1500;    // 첫뻑 1500원
const CHONGTONG_PRICE = 10000;     // 총통 10000원
const SELL_PRICE_PER_ITEM = 500;   // 광/쌍피 팔이 개당 500원

const MAX_PLAYERS = 4;

let state: GameState = {
  phase: "waiting",
  players: [],
  turnOrder: [],
  currentTurnIndex: 0,
  deck: [],
  floorCards: [],
  roundNumber: 0,
  sellQueue: [],
  sellerPlayerId: null,
  log: [],
};

function addLog(msg: string) {
  const ts = new Date().toLocaleTimeString("ko-KR");
  state.log.push(`[${ts}] ${msg}`);
  if (state.log.length > 200) state.log.shift();
  console.log(`[LOG] ${msg}`);
}

// ──────────────────────────────────────────────
// 플레이어 관리
// ──────────────────────────────────────────────

function createPlayer(name: string): Player {
  return {
    id: crypto.randomUUID(),
    name,
    hand: [],
    captured: [],
    score: 0,
    balance: 0,
    status: "playing",
    isReady: false,
  };
}

function getPlayer(id: string): Player | undefined {
  return state.players.find((p) => p.id === id);
}

function getActivePlayers(): Player[] {
  return state.players.filter((p) => p.status === "playing");
}

// ──────────────────────────────────────────────
// 게임 시작 / 순서 결정
// ──────────────────────────────────────────────

function startGame() {
  if (state.players.length < MAX_PLAYERS) {
    addLog(`아직 ${MAX_PLAYERS}명이 모이지 않았습니다. (현재 ${state.players.length}명)`);
    return;
  }

  // 첫 게임: 무작위 순서
  if (state.roundNumber === 0) {
    state.turnOrder = shuffle(state.players.map((p) => p.id));
    addLog(`첫 게임 순서 결정: ${state.turnOrder.map((id) => getPlayer(id)?.name).join(" → ")}`);
  }

  dealCards();
  state.phase = "playing";
  state.roundNumber++;
  state.currentTurnIndex = 0;
  addLog(`=== 라운드 ${state.roundNumber} 시작 ===`);
  addLog(`선: ${getPlayer(state.turnOrder[0])?.name}`);
}

function dealCards() {
  const deck = shuffle(buildDeck());
  state.deck = deck;
  state.floorCards = [];

  // 초기 배분: 각자 7장, 바닥 6장 (3+1+3+1+3+1 방식은 생략하고 단순 배분)
  const activePlayers = state.turnOrder.map((id) => getPlayer(id)!).filter(Boolean);
  for (const p of activePlayers) {
    p.hand = [];
    p.captured = [];
  }

  // 각 플레이어 7장씩
  for (let i = 0; i < 7; i++) {
    for (const p of activePlayers) {
      const card = state.deck.pop();
      if (card) p.hand.push(card);
    }
  }

  // 바닥 6장
  for (let i = 0; i < 6; i++) {
    const card = state.deck.pop();
    if (card) state.floorCards.push(card);
  }

  addLog(`카드 배분 완료 (덱 잔여: ${state.deck.length}장)`);

  // 첫뻑 체크
  checkFirstBbuck();
}

function checkFirstBbuck() {
  // 바닥에 같은 달 카드 3장 이상 → 첫뻑
  const monthCount: Record<number, number> = {};
  for (const c of state.floorCards) {
    monthCount[c.month] = (monthCount[c.month] || 0) + 1;
  }
  for (const [month, cnt] of Object.entries(monthCount)) {
    if (cnt >= 3) {
      addLog(`🎯 첫뻑 발생! (${month}월 ${cnt}장) → 선이 1500원 수령`);
      const seller = getPlayer(state.turnOrder[0]);
      if (seller) {
        seller.balance += FIRST_BBUCK_PRICE * (state.players.length - 1);
        for (const p of state.players) {
          if (p.id !== seller.id) p.balance -= FIRST_BBUCK_PRICE;
        }
      }
    }
  }
}

// ──────────────────────────────────────────────
// 턴 처리
// ──────────────────────────────────────────────

function currentPlayer(): Player | undefined {
  return getPlayer(state.turnOrder[state.currentTurnIndex]);
}

function playCard(playerId: string, cardId: string): string {
  if (state.phase !== "playing") return "게임 진행 중이 아닙니다.";
  const player = currentPlayer();
  if (!player || player.id !== playerId) return "당신의 턴이 아닙니다.";

  const cardIndex = player.hand.findIndex((c) => c.id === cardId);
  if (cardIndex === -1) return "해당 카드가 없습니다.";

  const card = player.hand.splice(cardIndex, 1)[0];

  // 바닥에 같은 달 매칭
  const matched = state.floorCards.filter((c) => c.month === card.month);
  if (matched.length === 1) {
    // 1장 매칭 → 가져가기
    player.captured.push(card, matched[0]);
    state.floorCards = state.floorCards.filter((c) => c.id !== matched[0].id);
    addLog(`${player.name}: ${card.name} → ${matched[0].name} 획득`);
  } else if (matched.length >= 2) {
    // 2장 이상 매칭 → 전부 가져가기
    player.captured.push(card, ...matched);
    state.floorCards = state.floorCards.filter((c) => !matched.find((m) => m.id === c.id));
    addLog(`${player.name}: ${card.name} → ${matched.length}장 획득`);
  } else {
    // 매칭 없음 → 바닥에 놓기
    state.floorCards.push(card);
    addLog(`${player.name}: ${card.name} → 바닥에 놓음`);
  }

  // 덱에서 1장 뒤집기
  const deckCard = state.deck.pop();
  if (deckCard) {
    const deckMatched = state.floorCards.filter((c) => c.month === deckCard.month);
    if (deckMatched.length === 1) {
      player.captured.push(deckCard, deckMatched[0]);
      state.floorCards = state.floorCards.filter((c) => c.id !== deckMatched[0].id);
      addLog(`덱: ${deckCard.name} → ${deckMatched[0].name} 획득`);
    } else if (deckMatched.length >= 2) {
      player.captured.push(deckCard, ...deckMatched);
      state.floorCards = state.floorCards.filter((c) => !deckMatched.find((m) => m.id === c.id));
    } else {
      state.floorCards.push(deckCard);
    }
  }

  // 총통 체크: 한 달 4장 전부 획득
  checkChongtong(player);

  // 점수 업데이트
  player.score = calculateScore(player.captured);

  // 다음 턴 또는 핸드가 없으면 라운드 종료 체크
  if (player.hand.length === 0 && state.deck.length === 0) {
    endRound();
  } else {
    advanceTurn();
  }

  return "ok";
}

function checkChongtong(player: Player) {
  const monthCount: Record<number, number> = {};
  for (const c of player.captured) {
    monthCount[c.month] = (monthCount[c.month] || 0) + 1;
  }
  for (const [month, cnt] of Object.entries(monthCount)) {
    if (cnt >= 4) {
      addLog(`🏆 ${player.name} 총통 발생! (${month}월) → 10000원 수령`);
      player.balance += CHONGTONG_PRICE * (state.players.length - 1);
      for (const p of state.players) {
        if (p.id !== player.id) p.balance -= CHONGTONG_PRICE;
      }
    }
  }
}

function advanceTurn() {
  state.currentTurnIndex = (state.currentTurnIndex + 1) % state.turnOrder.length;
  addLog(`다음 턴: ${currentPlayer()?.name}`);
}

// ──────────────────────────────────────────────
// 죽기 / 고 / 스톱
// ──────────────────────────────────────────────

function playerAction(playerId: string, action: "go" | "stop" | "die"): string {
  if (state.phase !== "playing") return "게임 진행 중이 아닙니다.";
  const player = getPlayer(playerId);
  if (!player) return "플레이어를 찾을 수 없습니다.";

  if (action === "die") {
    player.status = "dead";
    addLog(`${player.name} 죽음 선택`);

    // 죽은 플레이어를 turnOrder에서 제거
    state.turnOrder = state.turnOrder.filter((id) => id !== playerId);

    // 마지막 남은 플레이어(광팔이 대상)가 생기는 경우 처리
    if (state.turnOrder.length === 1) {
      enterSellingPhase(state.turnOrder[0]);
      return "ok";
    }

    // turnOrder에서 제거 후 인덱스 조정
    if (state.currentTurnIndex >= state.turnOrder.length) {
      state.currentTurnIndex = 0;
    }

    return "ok";
  }

  if (action === "stop") {
    addLog(`${player.name} 스톱!`);
    endRound(playerId);
    return "ok";
  }

  // go → 계속 진행
  addLog(`${player.name} 고!`);
  return "ok";
}

// ──────────────────────────────────────────────
// 팔이 (광 / 쌍피)
// ──────────────────────────────────────────────

function enterSellingPhase(sellerId: string) {
  state.phase = "selling";
  state.sellerPlayerId = sellerId;
  const seller = getPlayer(sellerId);
  if (!seller) return;

  // 판매 가능 카드: 광, 쌍피
  const sellable = seller.hand.filter(
    (c) => c.type === "gwang" || c.type === "ssangpi"
  );
  state.sellQueue = sellable.map((c) => ({
    card: c,
    pricePerItem: SELL_PRICE_PER_ITEM,
  }));

  addLog(`=== 팔이 단계 ===`);
  addLog(`${seller.name}이(가) 팔이 진행 중 (광/쌍피 ${sellable.length}장)`);
}

function sellItem(sellerId: string, cardId: string): string {
  if (state.phase !== "selling") return "팔이 단계가 아닙니다.";
  if (state.sellerPlayerId !== sellerId) return "팔이 권한이 없습니다.";

  const seller = getPlayer(sellerId);
  if (!seller) return "판매자를 찾을 수 없습니다.";

  const itemIndex = state.sellQueue.findIndex((i) => i.card.id === cardId);
  if (itemIndex === -1) return "해당 카드를 팔 수 없습니다.";

  const item = state.sellQueue.splice(itemIndex, 1)[0];
  const price = item.pricePerItem;

  // 선(첫 순서) 제외, 나머지 플레이어가 지불
  const firstPlayerId = state.turnOrder[0]; // 현재 살아있는 순서의 첫 번째 = 선
  for (const p of state.players) {
    if (p.id !== sellerId && p.id !== firstPlayerId) {
      p.balance -= price;
      seller.balance += price;
    }
  }

  addLog(
    `${seller.name} 팔이: ${item.card.name} → ${price}원 수령 (선 [${getPlayer(firstPlayerId)?.name}] 제외 각자 지불)`
  );

  return "ok";
}

function removePlayer(playerId: string): string {
  const idx = state.players.findIndex((p) => p.id === playerId);
  if (idx === -1) return "플레이어를 찾을 수 없습니다.";

  const player = state.players[idx];

  state.turnOrder = state.turnOrder.filter((id) => id !== playerId);
  if (state.currentTurnIndex >= state.turnOrder.length) {
    state.currentTurnIndex = 0;
  }

  state.players.splice(idx, 1);
  addLog('${player.name} 퇴장 (${state.players.length}/${MAX_PLAYERS})');

  if (state.phase !== "waiting") {
    state.phase = "waiting";
    state.sellQueue = [];
    state.sellerPlayerId = null;
    for (const p of state.players) {
      p.isReady = false;
      p.status = "playing";
      p.hand = [];
      p.captured = [];
      p.score = 0;
    }
    addLog("플레이어 퇴장으로 게임이 중단되고 대기 상태로 전환되었습니다.");
  }

  return "ok";
}

function endSelling() {
  if (state.phase !== "selling") return;
  addLog(`팔이 종료`);
  endRound(state.sellerPlayerId ?? undefined);
}

// ──────────────────────────────────────────────
// 라운드 종료 / 정산
// ──────────────────────────────────────────────

function endRound(winnerId?: string) {
  state.phase = "roundEnd";

  let winner: Player | undefined;

  if (winnerId) {
    winner = getPlayer(winnerId);
  } else {
    // 스톱 없이 카드 소진 → 점수 가장 높은 플레이어
    const active = getActivePlayers();
    winner = active.reduce((best, p) => (p.score > best.score ? p : best), active[0]);
  }

  if (!winner) {
    addLog("승자를 결정할 수 없습니다.");
    return;
  }

  addLog(`=== 라운드 종료 ===`);
  addLog(`승자: ${winner.name} (${winner.score}쩜)`);

  // 정산: 각 패배자 점수만큼 지불
  for (const p of state.players) {
    if (p.id === winner.id) continue;
    const loserScore = p.score;
    const amount = loserScore * POINTS_PER_SCORE;
    p.balance -= amount;
    winner.balance += amount;
    addLog(`${p.name} → ${winner.name}: ${amount}원 (${loserScore}쩜)`);
  }

  // 잔액 현황 출력
  addLog(`=== 잔액 현황 ===`);
  for (const p of state.players) {
    addLog(`${p.name}: ${p.balance >= 0 ? "+" : ""}${p.balance.toLocaleString()}원`);
  }

  // 다음 라운드: 이긴 사람이 선
  const newOrder = [winner.id, ...state.players.filter((p) => p.id !== winner.id).map((p) => p.id)];
  state.turnOrder = newOrder;

  // 플레이어 상태 초기화
  for (const p of state.players) {
    p.status = "playing";
    p.score = 0;
    p.hand = [];
    p.captured = [];
  }

  state.sellQueue = [];
  state.sellerPlayerId = null;
  state.phase = "waiting"; // 다음 게임 준비
  addLog(`다음 라운드 준비 중. 선: ${winner.name}`);
}

// ──────────────────────────────────────────────
// HTTP API 서버
// ──────────────────────────────────────────────

function jsonResponse(res: http.ServerResponse, data: unknown, status = 200) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data, null, 2));
}

function getBody(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body));
      } catch {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const url = req.url ?? "/";
  const method = req.method ?? "GET";

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  // ── 라우팅 ──

  // GET /state → 전체 게임 상태
  if (url === "/state" && method === "GET") {
    return jsonResponse(res, {
      phase: state.phase,
      roundNumber: state.roundNumber,
      players: state.players.map((p) => ({
        id: p.id,
        name: p.name,
        handCount: p.hand.length,
        capturedCount: p.captured.length,
        score: p.score,
        balance: p.balance,
        status: p.status,
        isReady: p.isReady,
      })),
      turnOrder: state.turnOrder,
      currentPlayer: currentPlayer()?.name ?? null,
      floorCards: state.floorCards,
      deckRemaining: state.deck.length,
      sellQueue: state.sellQueue,
      log: state.log.slice(-30),
    });
  }

  // POST /join → 플레이어 참가
  if (url === "/join" && method === "POST") {
    const body = await getBody(req);
    const name = String(body.name ?? "").trim();
    if (!name) return jsonResponse(res, { error: "이름을 입력하세요." }, 400);
    if (state.players.length >= MAX_PLAYERS) return jsonResponse(res, { error: "정원 초과" }, 400);
    if (state.phase !== "waiting") return jsonResponse(res, { error: "게임이 진행 중입니다." }, 400);

    const player = createPlayer(name);
    state.players.push(player);
    addLog(`${name} 접속 (${state.players.length}/${MAX_PLAYERS})`);

    if (state.players.length === MAX_PLAYERS) {
      addLog("4명 모두 접속 완료. 모두 준비 버튼을 눌러주세요.");
    }

    return jsonResponse(res, { playerId: player.id, name: player.name });
  }

  // POST /ready → 준비 완료
  if (url === "/ready" && method === "POST") {
    const body = await getBody(req);
    const player = getPlayer(String(body.playerId ?? ""));
    if (!player) return jsonResponse(res, { error: "플레이어 없음" }, 404);

    player.isReady = true;
    addLog(`${player.name} 준비 완료`);

    if (state.players.length === MAX_PLAYERS && state.players.every((p) => p.isReady)) {
      addLog("모두 준비 완료! 게임 시작!");
      for (const p of state.players) p.isReady = false;
      startGame();
    }

    return jsonResponse(res, { ok: true });
  }

  // POST /play → 카드 내기
  if (url === "/play" && method === "POST") {
    const body = await getBody(req);
    const result = playCard(String(body.playerId ?? ""), String(body.cardId ?? ""));
    return jsonResponse(res, { result });
  }

  // POST /action → 고/스톱/죽음
  if (url === "/action" && method === "POST") {
    const body = await getBody(req);
    const action = String(body.action ?? "") as "go" | "stop" | "die";
    const result = playerAction(String(body.playerId ?? ""), action);
    return jsonResponse(res, { result });
  }

  // POST /sell → 팔이 (광/쌍피 한 장 판매)
  if (url === "/sell" && method === "POST") {
    const body = await getBody(req);
    const result = sellItem(String(body.playerId ?? ""), String(body.cardId ?? ""));
    return jsonResponse(res, { result });
  }

  // POST /sell/done → 팔이 종료
  if (url === "/sell/done" && method === "POST") {
    endSelling();
    return jsonResponse(res, { ok: true });
  }

  // POST /leave → 플레이어 퇴장
  if (url === "/leave" && method === "POST") {
    const body = await getBody(req);
    const result = removePlayer(String(body.playerId ?? ""));
    return jsonResponse(res, { result });
  }

  
  // GET /hand/:playerId → 내 패
  if (url.startsWith("/hand/") && method === "GET") {
    const playerId = url.replace("/hand/", "");
    const player = getPlayer(playerId);
    if (!player) return jsonResponse(res, { error: "플레이어 없음" }, 404);
    return jsonResponse(res, { hand: player.hand });
  }

  // 404
  return jsonResponse(res, { error: "Not Found" }, 404);
});

const PORT = Number(process.env.PORT ?? 3000);
server.listen(PORT, () => {
  console.log(`\n🎴 고스톱 서버 시작 → http://localhost:${PORT}`);
  console.log(`  GET  /state          전체 게임 상태`);
  console.log(`  POST /join           { name }  → 참가`);
  console.log(`  POST /ready          { playerId }  → 준비`);
  console.log(`  POST /play           { playerId, cardId }  → 카드 내기`);
  console.log(`  POST /action         { playerId, action: go|stop|die }`);
  console.log(`  POST /sell           { playerId, cardId }  → 팔이`);
  console.log(`  POST /sell/done      팔이 종료`);
  console.log(`  GET  /hand/:id       내 패 조회\n`);
});

export { state, GameState, Player, Card };
