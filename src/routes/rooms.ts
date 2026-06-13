// src/routes/room.ts

import { Router, Request, Response } from 'express';
import { query } from '../db';
import { requireAuth } from '../middleware/auth';

export const roomsRouter = Router();

// ─── ルーム一覧 GET /api/rooms ───
roomsRouter.get('/', async (_req, res: Response) => {
  try {
    const result = await query(`
      SELECT
        r.*,
        u.handle_name AS owner_name,
        COUNT(rm.user_id) FILTER (WHERE rm.is_spectator = FALSE) AS member_count
      FROM rooms r
      JOIN users u ON r.owner_id = u.id
      LEFT JOIN room_members rm ON r.id = rm.room_id
      WHERE r.status = 'waiting'
      GROUP BY r.id, u.handle_name
      ORDER BY r.created_at DESC
    `);
    res.json(result.rows);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ─── ルーム詳細 GET /api/rooms/:id ───
roomsRouter.get('/:id', async (req: Request, res: Response) => {
  try {
    const roomResult = await query(
      `SELECT r.*, u.handle_name AS owner_name
       FROM rooms r
       JOIN users u ON r.owner_id = u.id
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (roomResult.rows.length === 0) {
      res.status(404).json({ error: 'ルームが見つかりません' });
      return;
    }
    const membersResult = await query(
      `SELECT u.id, u.handle_name, u.rating, rm.is_spectator
       FROM room_members rm
       JOIN users u ON rm.user_id = u.id
       WHERE rm.room_id = $1`,
      [req.params.id]
    );
    res.json({ ...roomResult.rows[0], members: membersResult.rows });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ─── ルーム作成 POST /api/rooms ───
roomsRouter.post('/', requireAuth, async (req: Request, res: Response) => {
  const { maxPlayers = 10, roleConfig = {}, ownerIsSpectator = false, name = '新しい村' } = req.body;
  const userId = req.session.userId!;

  if (maxPlayers < 5 || maxPlayers > 20) {
    res.status(400).json({ error: 'プレイヤー数は5〜20人で設定してください' });
    return;
  }

  try {
    const roomResult = await query(
      `INSERT INTO rooms (owner_id, name, max_players, role_config, owner_is_spectator)
       VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [userId, name, maxPlayers, JSON.stringify(roleConfig), ownerIsSpectator]
    );
    const room = roomResult.rows[0];

    // オーナー自身をメンバーに追加
    await query(
      `INSERT INTO room_members (room_id, user_id, is_spectator)
       VALUES ($1, $2, $3)`,
      [room.id, userId, ownerIsSpectator]
    );

    res.status(201).json(room);
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ─── 入室 POST /api/rooms/:id/join ───
roomsRouter.post('/:id/join', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const roomId = parseInt(req.params.id as string);
  const { asSpectator = false } = req.body;

  try {
    const roomResult = await query('SELECT * FROM rooms WHERE id = $1', [roomId]);
    if (roomResult.rows.length === 0) {
      res.status(404).json({ error: 'ルームが見つかりません' });
      return;
    }
    const room = roomResult.rows[0];

    if (room.status !== 'waiting') {
      res.status(400).json({ error: 'すでにゲームが始まっています' });
      return;
    }

    // BANチェック
    const banCheck = await query(
      `SELECT 1 FROM user_blocks WHERE blocker_id = $1 AND blocked_id = $2`,
      [room.owner_id, userId]
    );
    if (banCheck.rows.length > 0) {
      res.status(403).json({ error: 'このルームには入室できません' });
      return;
    }

    // 人数チェック（観戦者は上限なし）
    if (!asSpectator) {
      const countResult = await query(
        `SELECT COUNT(*) FROM room_members WHERE room_id = $1 AND is_spectator = FALSE`,
        [roomId]
      );
      if (parseInt(countResult.rows[0].count) >= room.max_players) {
        res.status(400).json({ error: 'ルームが満員です' });
        return;
      }
    }

    // 二重入室チェック
    const alreadyIn = await query(
      'SELECT 1 FROM room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, userId]
    );
    if (alreadyIn.rows.length > 0) {
      res.status(400).json({ error: 'すでに入室しています' });
      return;
    }

    await query(
      `INSERT INTO room_members (room_id, user_id, is_spectator) VALUES ($1, $2, $3)`,
      [roomId, userId, asSpectator]
    );
    res.json({ message: '入室しました', roomId, asSpectator });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ─── 退室 POST /api/rooms/:id/leave ───
roomsRouter.post('/:id/leave', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const roomId = parseInt(req.params.id as string);
  try {
    await query(
      'DELETE FROM room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, userId]
    );
    res.json({ message: '退室しました' });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});