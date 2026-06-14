// src/game/timer.ts


import { Server } from 'socket.io';
import { query } from '../db';
import {
  advancePhase, resolveNight, checkWinCondition, logEvent, ROLES
} from './engine';
import {
  broadcastPhaseChange, broadcastGameEnd, broadcastPlayerDeath
} from '../socket/index';
import { broadcastSystemMessage } from '../socket/systemMessages';
import { msgVoteSummary } from '../socket/gameMessages';

const activeTimers = new Map<number, NodeJS.Timeout>();

// フェーズ終了タイマーをセット
export const schedulePhaseEnd = (io: Server, gameId: number, phaseEndsAt: Date) => {
  // 既存タイマーをクリア
  const existing = activeTimers.get(gameId);
  if (existing) clearTimeout(existing);

  const delay = phaseEndsAt.getTime() - Date.now();

  // 既に期限切れなら即実行、そうでなければ delay 後に実行
  const timer = setTimeout(
    () => handlePhaseEnd(io, gameId),
    Math.max(0, delay)
  );
  activeTimers.set(gameId, timer);
};

export const cancelTimer = (gameId: number) => {
  const t = activeTimers.get(gameId);
  if (t) clearTimeout(t);
  activeTimers.delete(gameId);
};

// フェーズ終了時の処理
const handlePhaseEnd = async (io: Server, gameId: number) => {
  try {
    const gameResult = await query('SELECT * FROM games WHERE id = $1', [gameId]);
    const game = gameResult.rows[0];
    if (!game || game.status === 'finished') return;

    // 投票集計・処刑（day_vote フェーズ終了時）
    if (game.current_phase === 'day_vote') {
      await fillMissingVotes(io, gameId, game.current_day);
      await executeVote(io, gameId, game.current_day);
    }

    // 夜アクション処理（night フェーズ終了時）
    if (game.current_phase === 'night') {
      await handleMissingNightActions(io, gameId, game.current_day);
      const { killTarget } = await resolveNight(gameId);
      if (killTarget) {
  broadcastPlayerDeath(io, gameId, killTarget);
  const info = await query(
    `SELECT u.handle_name, gp.role FROM game_players gp
     JOIN users u ON gp.user_id = u.id
     WHERE gp.game_id = $1 AND gp.user_id = $2`,
    [gameId, killTarget]
  );
  if (info.rows[0]) {
    const roleLabel = ROLES[info.rows[0].role as keyof typeof ROLES]?.label ?? info.rows[0].role;
    broadcastSystemMessage(io, `game:${gameId}`,
      `「${info.rows[0].handle_name}」が夜の間に亡くなりました`);
      
      // 突然死と占われて死んだのを区別したい（メモ）
      // 役職名を表示する場合はこう
      //`「${info.rows[0].handle_name}」（${roleLabel}）が夜の間に亡くなりました`);
  }
}
    }

    // 勝利条件チェック
    const winner = await checkWinCondition(gameId);
    if (winner) {
      await query(
        `UPDATE games SET status = 'finished', winner_faction = $1, ended_at = NOW()
         WHERE id = $2`,
        [winner, gameId]
      );
      await query(
        `UPDATE rooms SET status = 'finished'
         WHERE id = (SELECT room_id FROM games WHERE id = $1)`,
        [gameId]
      );
      await logEvent(gameId, 'game_over', 'game_end', null, null, { winner });
      broadcastGameEnd(io, gameId, winner);
      activeTimers.delete(gameId);
      return;
    }

    // フェーズを進めて次のタイマーをセット
    const result = await advancePhase(gameId);
    broadcastPhaseChange(io, gameId, result.nextPhase, result.nextDay, result.phaseEndsAt);
    schedulePhaseEnd(io, gameId, result.phaseEndsAt);

    // Bot が即座に行動
    await performBotActions(gameId, result.nextPhase, result.nextDay);
    //schedulePhaseEndが2回呼ばれてるというのでこの行を削除しましたが動作確認してください（メモ）
    //schedulePhaseEnd(io, result.phaseEndsAt ? gameId : gameId, result.phaseEndsAt);

  } catch (e) {
    console.error(`[timer] game ${gameId} エラー:`, e);
  }
};

// ─── Bot 自動行動（フェーズ開始直後）───
const performBotActions = async (gameId: number, phase: string, currentDay: number) => {
  if (phase === 'day_vote') await performBotVotes(gameId, currentDay);
  if (phase === 'night')    await performBotNightActions(gameId, currentDay);
};

const performBotVotes = async (gameId: number, currentDay: number) => {
  const botsResult = await query(
    `SELECT gp.user_id FROM game_players gp
     JOIN users u ON gp.user_id = u.id
     WHERE gp.game_id = $1 AND gp.is_alive = TRUE AND u.is_bot = TRUE`,
    [gameId]
  );
  const targetsResult = await query(
    `SELECT user_id FROM game_players WHERE game_id = $1 AND is_alive = TRUE`,
    [gameId]
  );
  const targets: number[] = targetsResult.rows.map((r: { user_id: number }) => r.user_id);

  for (const bot of botsResult.rows) {
    const options = targets.filter(id => id !== bot.user_id);
    if (options.length === 0) continue;
    const targetId = options[Math.floor(Math.random() * options.length)];
    await logEvent(gameId, 'day_vote', 'vote', bot.user_id, targetId, { day: currentDay });
  }
};

const performBotNightActions = async (gameId: number, currentDay: number) => {
  const botsResult = await query(
    `SELECT gp.user_id, gp.role FROM game_players gp
     JOIN users u ON gp.user_id = u.id
     WHERE gp.game_id = $1 AND gp.is_alive = TRUE AND u.is_bot = TRUE
     AND gp.role IN ('werewolf', 'seer', 'knight')`,
    [gameId]
  );

  const targetsResult = await query(
    `SELECT user_id FROM game_players WHERE game_id = $1 AND is_alive = TRUE`,
    [gameId]
  );
  const targets: number[] = targetsResult.rows.map((r: { user_id: number }) => r.user_id);

  for (const bot of botsResult.rows) {
    const options = targets.filter(id => id !== bot.user_id);
    if (options.length === 0) continue;
    const targetId = options[Math.floor(Math.random() * options.length)];
    const eventType =
      bot.role === 'werewolf' ? 'kill_action' :
      bot.role === 'seer'     ? 'seer_action' : 'guard_action';
    await logEvent(gameId, 'night', eventType, bot.user_id, targetId,
      { day: currentDay }, bot.role === 'werewolf');
  }
};

// ─── フェーズ終了時の未行動ケア ───
// 未投票プレイヤーをランダム投票（Bot・人間両方）
const fillMissingVotes = async (io: Server, gameId: number, currentDay: number) => {
  const notVotedResult = await query(
    `SELECT gp.user_id, u.handle_name FROM game_players gp
     JOIN users u ON gp.user_id = u.id
     WHERE gp.game_id = $1 AND gp.is_alive = TRUE
     AND gp.user_id NOT IN (
       SELECT actor_id FROM game_events
       WHERE game_id = $1 AND phase = 'day_vote'
         AND event_type = 'vote' AND (data->>'day')::int = $2
         AND actor_id IS NOT NULL
     )`,
    [gameId, currentDay]
  );
  const targetsResult = await query(
    `SELECT user_id FROM game_players WHERE game_id = $1 AND is_alive = TRUE`,
    [gameId]
  );
  const targets: number[] = targetsResult.rows.map((r: { user_id: number }) => r.user_id);
  for (const player of notVotedResult.rows) {
    const options = targets.filter(id => id !== player.user_id);
    if (options.length === 0) continue;
    const targetId = options[Math.floor(Math.random() * options.length)];
    await logEvent(gameId, 'day_vote', 'vote', player.user_id, targetId,
      { day: currentDay, isAutoVote: true });
    broadcastSystemMessage(io, `game:${gameId}`,
   `⏰ 「${player.handle_name}」は時間内に投票しなかったため、ランダムに投票します`);
  }
};

// 役職未実行の人間プレイヤーを突然死
const handleMissingNightActions = async (io: Server, gameId: number, currentDay: number) => {
  const notActedResult = await query(
    `SELECT gp.user_id FROM game_players gp
     JOIN users u ON gp.user_id = u.id
     WHERE gp.game_id = $1 AND gp.is_alive = TRUE AND u.is_bot = FALSE
     AND gp.role IN ('werewolf', 'seer', 'knight')
     AND gp.user_id NOT IN (
       SELECT actor_id FROM game_events
       WHERE game_id = $1 AND phase = 'night'
         AND event_type IN ('kill_action', 'seer_action', 'guard_action')
         AND (data->>'day')::int = $2
         AND actor_id IS NOT NULL
     )`,
    [gameId, currentDay]
  );

  for (const player of notActedResult.rows) {
    await query(
      `UPDATE game_players SET is_alive = FALSE, died_at_day = $1
       WHERE game_id = $2 AND user_id = $3`,
      [currentDay, gameId, player.user_id]
    );
    await logEvent(gameId, 'night', 'sudden_death', null, player.user_id, { day: currentDay });
    broadcastPlayerDeath(io, gameId, player.user_id);
const nameResult = await query(
  'SELECT handle_name FROM users WHERE id = $1', [player.user_id]
);
const name = nameResult.rows[0]?.handle_name ?? '不明';
broadcastSystemMessage(io, `game:${gameId}`,
  `💀 「${name}」は夜のうちに行動しなかったため、突然死しました`);
  }
};


// 投票集計 → 最多得票者を処刑
const executeVote = async (io: Server, gameId: number, currentDay: number) => {
  // 投票者・投票先・その投票者が受けた票数を一度に取得
  const allVotesResult = await query(
    `SELECT
       u_voter.handle_name  AS voter_name,
       u_target.handle_name AS voted_for_name,
       ge.target_id,
       COALESCE(received.cnt, 0) AS votes_received,
       (ge.data->>'isAutoVote')::boolean AS is_auto
     FROM game_events ge
     JOIN game_players gp_voter
    ON gp_voter.game_id = ge.game_id AND gp_voter.user_id = ge.actor_id
     JOIN users u_voter  ON ge.actor_id  = u_voter.id
     JOIN users u_target ON ge.target_id = u_target.id
     LEFT JOIN (
       SELECT target_id, COUNT(*) AS cnt
       FROM game_events
       WHERE game_id = $1
         AND phase = 'day_vote'
         AND event_type = 'vote'
         AND (data->>'day')::int = $2
       GROUP BY target_id
     ) received ON received.target_id = ge.actor_id
     WHERE ge.game_id = $1
       AND ge.phase = 'day_vote'
       AND ge.event_type = 'vote'
       AND (ge.data->>'day')::int = $2
    ORDER BY gp_voter.id ASC`,
    [gameId, currentDay]
  );

  if (allVotesResult.rows.length === 0) return;

  const lines = allVotesResult.rows.map((r: {
    voter_name: string;
    voted_for_name: string;
    votes_received: number;
    is_auto: boolean;
  }) => {
    const name = r.is_auto ? `${r.voter_name}（自動）` : r.voter_name;
    return `${name}（${r.votes_received}票）→${r.voted_for_name}`;
  });

  msgVoteSummary(io, gameId, lines);

  // 最多得票者を処刑（同票の場合は先に投票された方を優先）
  // 全員の得票数を取得
const tallyResult = await query(
  `SELECT target_id, COUNT(*) AS cnt
   FROM game_events
   WHERE game_id = $1
     AND phase = 'day_vote'
     AND event_type = 'vote'
     AND (data->>'day')::int = $2
   GROUP BY target_id
   ORDER BY cnt DESC`,
  [gameId, currentDay]
);

// 最多票数と同票の候補を全員リストアップ
const maxCnt = Number(tallyResult.rows[0].cnt);
const topCandidates = tallyResult.rows.filter(
  (r: { target_id: number; cnt: string }) => Number(r.cnt) === maxCnt
);

// 同票ならランダム、そうでなければ確定
let targetId: number;
if (topCandidates.length === 1) {
  targetId = topCandidates[0].target_id;
} else {
  const chosen = topCandidates[Math.floor(Math.random() * topCandidates.length)];
  targetId = chosen.target_id;
  broadcastSystemMessage(io, `game:${gameId}`, '⚖️ 同票のためランダムで処刑先を決定します。');
}


  await query(
    `UPDATE game_players SET is_alive = FALSE, died_at_day = $1
     WHERE game_id = $2 AND user_id = $3`,
    [currentDay, gameId, targetId]
  );
  await logEvent(gameId, 'day_vote', 'execution', null, targetId, { day: currentDay });
  broadcastPlayerDeath(io, gameId, targetId);

  const info = await query(
    `SELECT u.handle_name, gp.role FROM game_players gp
     JOIN users u ON gp.user_id = u.id
     WHERE gp.game_id = $1 AND gp.user_id = $2`,
    [gameId, targetId]
  );
  if (info.rows[0]) {
    const roleLabel = ROLES[info.rows[0].role as keyof typeof ROLES]?.label ?? info.rows[0].role;
    broadcastSystemMessage(io, `game:${gameId}`,
      `⚔️ 「${info.rows[0].handle_name}」が処刑されました`);
      //↓これは「名前」（役職名）を表示するシステムメッセージ（メモ）
    //`⚔️ 「${info.rows[0].handle_name}」（${roleLabel}）が処刑されました`);
  }
};

// サーバー再起動時に進行中ゲームのタイマーを復元
export const resumeActiveTimers = async (io: Server) => {
  const result = await query(
    `SELECT id, phase_ends_at FROM games
     WHERE status = 'in_progress' AND phase_ends_at IS NOT NULL`
  );
  for (const row of result.rows) {
    console.log(`[timer] 復元: game ${row.id}`);
    schedulePhaseEnd(io, row.id, new Date(row.phase_ends_at));
  }
};