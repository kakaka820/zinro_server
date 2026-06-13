// src/routes/bets.ts
import { Router, Request, Response } from 'express';
import { query } from '../db';
import { requireAuth } from '../middleware/auth';

export const betsRouter = Router();

// ─── 賭け投票 POST /api/bets ───
betsRouter.post('/', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const { gameId, betOn } = req.body; // betOn: 'village' | 'wolf'

  if (!['village', 'wolf'].includes(betOn)) {
    res.status(400).json({ error: '無効な賭け対象です' }); return;
  }

  try {
    // ゲームが始まってるか確認
    const gameResult = await query(
      `SELECT status, current_phase FROM games WHERE id = $1`, [gameId]
    );
    const game = gameResult.rows[0];
    if (!game) { res.status(404).json({ error: 'ゲームが見つかりません' }); return; }

    // 昼議論フェーズ中のみ賭け可能
    if (game.current_phase !== 'day_discussion' || game.status !== 'playing') {
      res.status(400).json({ error: '賭けは昼議論フェーズのみ可能です' }); return;
    }

    // 同じゲームに既に賭けてないか確認
    const existing = await query(
      `SELECT id FROM bets WHERE game_id = $1 AND user_id = $2`, [gameId, userId]
    );
    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'すでにこのゲームに賭けています' }); return;
    }

    // プレイヤー自身は賭け不可
    const isPlayer = await query(
      `SELECT 1 FROM game_players WHERE game_id = $1 AND user_id = $2`, [gameId, userId]
    );
    if (isPlayer.rows.length > 0) {
      res.status(403).json({ error: 'ゲーム参加者は賭けられません' }); return;
    }

    const result = await query(
      `INSERT INTO bets (game_id, user_id, bet_on) VALUES ($1, $2, $3) RETURNING *`,
      [gameId, userId, betOn]
    );
    res.status(201).json(result.rows[0]);
  } catch (e) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ─── 賭け結果一覧 GET /api/bets/:gameId ───
betsRouter.get('/:gameId', async (req: Request, res: Response) => {
  const gameId = parseInt(req.params.gameId as string);
  try {
    const result = await query(
      `SELECT b.*, u.handle_name,
              g.winner_faction,
              CASE
                WHEN g.winner_faction IS NULL THEN NULL
                WHEN b.bet_on = g.winner_faction THEN 'win'
                ELSE 'lose'
              END AS result
       FROM bets b
       JOIN users u ON b.user_id = u.id
       JOIN games g ON b.game_id = g.id
       WHERE b.game_id = $1
       ORDER BY b.created_at ASC`,
      [gameId]
    );
    res.json(result.rows);
  } catch (e) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});