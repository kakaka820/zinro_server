// src/routes/room.ts

import { Router, Request, Response } from 'express';
import { Server } from 'socket.io';
import { query } from '../db';
import { requireAuth } from '../middleware/auth';

const BOT_NAMES = ['甲', '乙', '丙', '丁', '戊', '寅さん', '金さん', '銀さん', '権兵衛', 'マミ'];

export const createRoomsRouter = (io: Server) => {
  const router = Router();

// ─── ルーム一覧 GET /api/rooms ───
router.get('/', async (_req, res: Response) => {
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
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const roomResult = await query(
      `SELECT r.*, u.handle_name AS owner_name, g.id AS current_game_id
       FROM rooms r
       JOIN users u ON r.owner_id = u.id
       LEFT JOIN games g ON g.room_id = r.id AND g.status = 'in_progress'
       WHERE r.id = $1`,
      [req.params.id]
    );
    if (roomResult.rows.length === 0) {
      res.status(404).json({ error: 'ルームが見つかりません' });
      return;
    }
    const membersResult = await query(
      `SELECT u.id, u.handle_name, u.rating, rm.is_spectator, u.is_bot
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
router.post('/', requireAuth, async (req: Request, res: Response) => {
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
router.post('/:id/join', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const roomId = parseInt(req.params.id as string);
  const { asSpectator = false } = req.body ?? {};

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
       res.json({ message: 'すでに入室しています', roomId, asSpectator });
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
router.post('/:id/leave', requireAuth, async (req: Request, res: Response) => {
  const userId = req.session.userId!;
  const roomId = parseInt(req.params.id as string);
  try {
    await query(
      'DELETE FROM room_members WHERE room_id = $1 AND user_id = $2',
      [roomId, userId]
    );

    // 残りメンバー数を確認
    const remaining = await query(
      'SELECT COUNT(*) FROM room_members WHERE room_id = $1',
      [roomId]
    );
    const remainingCount = parseInt(remaining.rows[0].count);


    //現行の仕様ではゲーム終了後村のログも削除されるので後々対応する（rooms削除時にgamesのroom_idをNULLにすることでゲームは残す）（メモ）
    if (remainingCount === 0) {
      // ゲームが紐づいている場合は先に削除
      const gameIds = await query('SELECT id FROM games WHERE room_id = $1', [roomId]);
      for (const g of gameIds.rows) {
        await query('DELETE FROM game_events WHERE game_id = $1', [g.id]);
        await query('DELETE FROM game_players WHERE game_id = $1', [g.id]);
      }
      await query('DELETE FROM games WHERE room_id = $1', [roomId]);
      // 誰もいなくなった → 部屋ごと削除
      await query('DELETE FROM rooms WHERE id = $1', [roomId]);
      res.json({ message: '村を閉じました', roomClosed: true });
      return;
    }

    // オーナーが退室した場合、オーナー権限を次の人に移譲
    const roomResult = await query('SELECT owner_id FROM rooms WHERE id = $1', [roomId]);
    if (roomResult.rows.length > 0 && roomResult.rows[0].owner_id === userId) {
      const newOwner = await query(
        `SELECT rm.user_id FROM room_members rm
        JOIN users u ON rm.user_id = u.id
        WHERE rm.room_id = $1 AND u.is_bot = FALSE
        LIMIT 1`,
        [roomId]
      );
      if (newOwner.rows.length > 0) {
        await query('UPDATE rooms SET owner_id = $1 WHERE id = $2',
          [newOwner.rows[0].user_id, roomId]);
      }
    }

    res.json({ message: '退室しました', roomClosed: false });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

  // ─── Bot追加 POST /api/rooms/:id/add-bot ───
  router.post('/:id/add-bot', requireAuth, async (req: Request, res: Response) => {
    const userId = req.session.userId!;
    const roomId = parseInt(req.params.id as string);
    try {
      const roomResult = await query('SELECT * FROM rooms WHERE id = $1', [roomId]);
      if (roomResult.rows.length === 0) { res.status(404).json({ error: 'ルームが見つかりません' }); return; }
      const room = roomResult.rows[0];
      if (room.owner_id !== userId) { res.status(403).json({ error: 'オーナーのみBotを追加できます' }); return; }

      const countResult = await query(
        'SELECT COUNT(*) FROM room_members WHERE room_id = $1 AND is_spectator = FALSE', [roomId]
      );
      if (parseInt(countResult.rows[0].count) >= room.max_players) {
        res.status(400).json({ error: 'ルームが満員です' }); return;
      }

      const namesResult = await query(
        `SELECT u.handle_name FROM room_members rm JOIN users u ON rm.user_id = u.id WHERE rm.room_id = $1`, [roomId]
      );
      const usedNames = new Set(namesResult.rows.map((r: { handle_name: string }) => r.handle_name));
      const botName = BOT_NAMES.find(n => !usedNames.has(n)) ?? `Bot${Date.now()}`;

      const botResult = await query(
        `INSERT INTO users (handle_name, password_hash, is_bot) VALUES ($1, 'bot_no_password', TRUE) RETURNING id`,
        [botName]
      );
      const botId = botResult.rows[0].id;
      await query('INSERT INTO room_members (room_id, user_id, is_spectator) VALUES ($1, $2, FALSE)', [roomId, botId]);

      io.to(`room:${roomId}`).emit('room_updated', { type: 'bot_added', botName });
      res.json({ message: 'Botを追加しました', botId, name: botName });
    } catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
  });

  // ─── キック POST /api/rooms/:id/kick ───
  router.post('/:id/kick', requireAuth, async (req: Request, res: Response) => {
    const userId = req.session.userId!;
    const roomId = parseInt(req.params.id as string);
    const { targetUserId } = req.body ?? {};
    if (!targetUserId) { res.status(400).json({ error: 'targetUserIdが必要です' }); return; }

    try {
      const roomResult = await query('SELECT owner_id FROM rooms WHERE id = $1', [roomId]);
      if (roomResult.rows.length === 0) { res.status(404).json({ error: 'ルームが見つかりません' }); return; }
      if (roomResult.rows[0].owner_id !== userId) { res.status(403).json({ error: 'オーナーのみキックできます' }); return; }
      if (targetUserId === userId) { res.status(400).json({ error: '自分自身はキックできません' }); return; }

      const targetResult = await query('SELECT is_bot FROM users WHERE id = $1', [targetUserId]);
      const isBot = targetResult.rows[0]?.is_bot;

      await query('DELETE FROM room_members WHERE room_id = $1 AND user_id = $2', [roomId, targetUserId]);
      if (isBot) await query('DELETE FROM users WHERE id = $1', [targetUserId]);

      io.to(`room:${roomId}`).emit('kicked', { userId: targetUserId });
      io.to(`room:${roomId}`).emit('room_updated', { type: 'user_kicked', userId: targetUserId });
      res.json({ message: 'キックしました' });
    } catch (e) { console.error(e); res.status(500).json({ error: 'サーバーエラー' }); }
  });

  return router;
};