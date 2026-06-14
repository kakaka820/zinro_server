// src/routes/games.ts
//ゲーム操作のエンドポイント

import { Router, Request, Response } from 'express';
import { query } from '../db';
import { requireAuth } from '../middleware/auth';
import {
  startGame, advancePhase, resolveNight,
  checkWinCondition, logEvent, getSeerResult, RoleName
} from '../game/engine';
import { Server } from 'socket.io';
import { broadcastPhaseChange, broadcastGameEnd, broadcastPlayerDeath } from '../socket/index';
import { msgGameStart, msgNightDeath, msgNoDeathAtNight } from '../socket/gameMessages';
import { schedulePhaseEnd, cancelTimer } from '../game/timer';


export const createGamesRouter = (io: Server) => {
  const router = Router();

// ─── ゲーム開始 POST /api/games/start ───
router.post('/start', requireAuth, async (req: Request, res: Response) => {
  const { roomId } = req.body;
  const userId = req.session.userId!;

  try {
    const roomResult = await query('SELECT * FROM rooms WHERE id = $1', [roomId]);
    const room = roomResult.rows[0];
    if (!room) { res.status(404).json({ error: 'ルームが見つかりません' }); return; }
    if (room.owner_id !== userId) { res.status(403).json({ error: 'オーナーのみ開始できます' }); return; }

    const game = await startGame(roomId);
    schedulePhaseEnd(io, game.id, new Date(game.phase_ends_at));

    // 部屋の全員にゲーム開始を通知
    io.to(`room:${roomId}`).emit('game_started', { gameId: game.id });
    msgGameStart(io, game.id);

    
    res.json(game);


  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'サーバーエラー';
    res.status(400).json({ error: msg });
  }
});

// ─── 自分の役職確認 GET /api/games/:id/my-role ───
router.get('/:id/my-role', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const gameId = parseInt(req.params.id as string);

  const result = await query(
    `SELECT role FROM game_players WHERE game_id = $1 AND user_id = $2`,
    [gameId, userId]
  );
  if (result.rows.length === 0) { res.status(404).json({ error: '参加していません' }); return; }
  res.json({ role: result.rows[0].role });
});

// ─── ゲーム状態取得 GET /api/games/:id ───
router.get('/:id', async (req: Request, res: Response) => {
  const gameId = parseInt(req.params.id as string);
  try {
    const gameResult = await query('SELECT * FROM games WHERE id = $1', [gameId]);
    if (gameResult.rows.length === 0) { res.status(404).json({ error: 'ゲームが見つかりません' }); return; }

    const playersResult = await query(
      `SELECT gp.user_id, gp.is_alive, gp.died_at_day, u.handle_name
       FROM game_players gp
       JOIN users u ON gp.user_id = u.id
       WHERE gp.game_id = $1`,
      [gameId]
    );
    // 役職は含めない（フロントに役職情報を全員分返すと不正行為になる）
    res.json({ ...gameResult.rows[0], players: playersResult.rows });
  } catch (e) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ─── 投票 POST /api/games/:id/vote ───
router.post('/:id/vote', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const gameId = parseInt(req.params.id as string);
  const { targetId } = req.body;

  try {
    const gameResult = await query('SELECT * FROM games WHERE id = $1', [gameId]);
    const game = gameResult.rows[0];
    if (game.current_phase !== 'day_vote') {
      res.status(400).json({ error: '投票フェーズではありません' }); return;
    }

    // 生存確認
    const playerResult = await query(
      `SELECT is_alive FROM game_players WHERE game_id = $1 AND user_id = $2`,
      [gameId, userId]
    );
    if (!playerResult.rows[0]?.is_alive) {
      res.status(400).json({ error: '死亡プレイヤーは投票できません' }); return;
    }

    await query(
      `DELETE FROM game_events
      WHERE game_id = $1 AND phase = 'day_vote' AND event_type = 'vote'
      AND actor_id = $2 AND (data->>'day')::int = $3`,
      [gameId, userId, game.current_day]
    );
    await logEvent(gameId, 'day_vote', 'vote', userId, targetId, { day: game.current_day });
    res.json({ message: '投票しました' });
  } catch (e) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ─── 夜アクション POST /api/games/:id/night-action ───
router.post('/:id/night-action', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const gameId = parseInt(req.params.id as string);
  const { targetId } = req.body;

  try {
    const gameResult = await query('SELECT * FROM games WHERE id = $1', [gameId]);
    const game = gameResult.rows[0];
    if (game.current_phase !== 'night') {
      res.status(400).json({ error: '夜フェーズではありません' }); return;
    }

    const playerResult = await query(
      `SELECT role FROM game_players WHERE game_id = $1 AND user_id = $2 AND is_alive = TRUE`,
      [gameId, userId]
    );
    if (playerResult.rows.length === 0) {
      res.status(403).json({ error: '行動できません' }); return;
    }

    const role: RoleName = playerResult.rows[0].role;
    let eventType: string;
    let responseData: object = {};

    switch (role) {
      case 'werewolf':
        eventType = 'kill_action';
        break;
      case 'seer': {
        eventType = 'seer_action';
        // 占い結果をすぐ返す
        const targetRole = await query(
          `SELECT role FROM game_players WHERE game_id = $1 AND user_id = $2`,
          [gameId, targetId]
        );
        const result = getSeerResult(targetRole.rows[0].role as RoleName);
        responseData = { result }; // 'wolf' or 'human'
        break;
      }
      case 'knight':
        eventType = 'guard_action';
        break;
      default:
        res.status(400).json({ error: 'この役職は夜アクションがありません' }); return;
    }

    await logEvent(gameId, 'night', eventType, userId, targetId,
      { day: game.current_day }, role === 'werewolf');
    res.json({ message: 'アクションを実行しました', ...responseData });
  } catch (e) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ─── フェーズ手動進行（開発・テスト用）POST /api/games/:id/advance ───
router.post('/:id/advance', requireAuth, async (req: Request, res: Response) => {
  const gameId = parseInt(req.params.id as string);
  try {
    // 夜→昼の切替時は夜アクション処理を先にやる
    const gameResult = await query('SELECT current_phase FROM games WHERE id = $1', [gameId]);
    //if (gameResult.rows[0].current_phase === 'night') {
    //  await resolveNight(gameId);
    // }
    //↑194-196行目までのこの行を↓これにおきかえてもいいかもしれんが、そもそも死者イベントが既に機能している気がしていて困惑中（メモ）
    /*if (gameResult.rows[0].current_phase === 'night') {
  const { killTarget } = await resolveNight(gameId);
  if (killTarget) {
    const nameResult = await query('SELECT handle_name FROM users WHERE id = $1', [killTarget]);
    const playerName = nameResult.rows[0]?.handle_name ?? '不明';
    broadcastPlayerDeath(io, gameId, killTarget);   // 死者イベント（今まで未実装だったバグ修正）
    msgNightDeath(io, gameId, playerName);
  } else {
    msgNoDeathAtNight(io, gameId);
  }
}
  */
    if (gameResult.rows[0].current_phase === 'night') {
      await resolveNight(gameId);
    }

    const winner = await checkWinCondition(gameId);
    if (winner) {
      await query(
        `UPDATE games SET status = 'finished', winner_faction = $1, ended_at = NOW() WHERE id = $2`,
        [winner, gameId]
      );
      await query(`UPDATE rooms SET status = 'finished' WHERE id =
        (SELECT room_id FROM games WHERE id = $1)`, [gameId]);
      await logEvent(gameId, 'game_over', 'game_end', null, null, { winner });
      cancelTimer(gameId);
      broadcastGameEnd(io, gameId, winner);
      res.json({ message: 'ゲーム終了', winner }); return;
    }

    const result = await advancePhase(gameId);
    schedulePhaseEnd(io, gameId, result.phaseEndsAt);
    broadcastPhaseChange(io, gameId, result.nextPhase, result.nextDay, result.phaseEndsAt);
    res.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : 'サーバーエラー';
    res.status(400).json({ error: msg });
  }
});

// ─── ゲームログ取得 GET /api/games/:id/log ───
router.get('/:id/log', async (req: Request, res: Response) => {
  const gameId = parseInt(req.params.id as string);
  try {
    const result = await query(
      `SELECT
         ge.*,
         u_actor.handle_name AS actor_name,
         u_target.handle_name AS target_name
       FROM game_events ge
       LEFT JOIN users u_actor ON ge.actor_id = u_actor.id
       LEFT JOIN users u_target ON ge.target_id = u_target.id
       WHERE ge.game_id = $1
       ORDER BY ge.created_at ASC`,
      [gameId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

return router;
};