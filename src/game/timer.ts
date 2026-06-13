// src/game/timer.ts


import { Server } from 'socket.io';
import { query } from '../db';
import {
  advancePhase, resolveNight, checkWinCondition, logEvent
} from './engine';
import {
  broadcastPhaseChange, broadcastGameEnd, broadcastPlayerDeath
} from '../socket/index';

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
      await executeVote(io, gameId, game.current_day);
    }

    // 夜アクション処理（night フェーズ終了時）
    if (game.current_phase === 'night') {
      const { killTarget } = await resolveNight(gameId);
      if (killTarget) {
        broadcastPlayerDeath(io, gameId, killTarget);
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

  } catch (e) {
    console.error(`[timer] game ${gameId} エラー:`, e);
  }
};

// 投票集計 → 最多得票者を処刑
const executeVote = async (io: Server, gameId: number, currentDay: number) => {
  const voteResult = await query(
    `SELECT target_id, COUNT(*) AS cnt
     FROM game_events
     WHERE game_id = $1
       AND phase = 'day_vote'
       AND event_type = 'vote'
       AND (data->>'day')::int = $2
     GROUP BY target_id
     ORDER BY cnt DESC
     LIMIT 1`,
    [gameId, currentDay]
  );

  if (voteResult.rows.length === 0) return; // 誰も投票しなかった

  const targetId = voteResult.rows[0].target_id;
  await query(
    `UPDATE game_players SET is_alive = FALSE, died_at_day = $1
     WHERE game_id = $2 AND user_id = $3`,
    [currentDay, gameId, targetId]
  );
  await logEvent(gameId, 'execution', 'execution', null, targetId, { day: currentDay });
  broadcastPlayerDeath(io, gameId, targetId);
};

// サーバー再起動時に進行中ゲームのタイマーを復元
export const resumeActiveTimers = async (io: Server) => {
  const result = await query(
    `SELECT id, phase_ends_at FROM games
     WHERE status = 'playing' AND phase_ends_at IS NOT NULL`
  );
  for (const row of result.rows) {
    console.log(`[timer] 復元: game ${row.id}`);
    schedulePhaseEnd(io, row.id, new Date(row.phase_ends_at));
  }
};