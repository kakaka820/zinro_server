// src/socket/index.ts

import { Server, Socket } from 'socket.io';
import { query } from '../db';
import { logEvent } from '../game/engine';

export const setupSocket = (io: Server) => {

  io.on('connection', (socket: Socket) => {
    console.log(`接続: ${socket.id}`);

    // ─── ルームに参加（待機室・観戦含む）───
    socket.on('join_room', async ({ roomId, userId }: { roomId: number; userId: number }) => {
      socket.join(`room:${roomId}`);
      // 入室を全員に通知
      const userResult = await query(
        'SELECT handle_name FROM users WHERE id = $1', [userId]
      );
      io.to(`room:${roomId}`).emit('room_updated', {
        type: 'user_joined',
        handleName: userResult.rows[0]?.handle_name,
        userId,
      });
    });

    // ─── ルームから退出 ───
    socket.on('leave_room', ({ roomId, userId }: { roomId: number; userId: number }) => {
      socket.leave(`room:${roomId}`);
      io.to(`room:${roomId}`).emit('room_updated', {
        type: 'user_left',
        userId,
      });
    });

    // ─── ゲームルームに参加（ゲーム開始後）───
    socket.on('join_game', async ({
      gameId, userId, isWolf
    }: { gameId: number; userId: number; isWolf: boolean }) => {
      // 全員参加するチャンネル
      socket.join(`game:${gameId}`);
      // 人狼専用チャンネル
      if (isWolf) socket.join(`game:${gameId}:wolves`);
    });

    // ─── チャット送信 ───
    socket.on('chat', async ({
      gameId, userId, message, isWolfChat
    }: { gameId: number; userId: number; message: string; isWolfChat: boolean }) => {
      // ゲームと送信者の確認
      const playerResult = await query(
        `SELECT gp.role, gp.is_alive, u.handle_name
         FROM game_players gp
         JOIN users u ON gp.user_id = u.id
         WHERE gp.game_id = $1 AND gp.user_id = $2`,
        [gameId, userId]
      );
      if (playerResult.rows.length === 0) return;

      const { role, is_alive, handle_name } = playerResult.rows[0];

      // 死亡者は発言不可（観戦チャットは別途実装）
      if (!is_alive) return;

      // 狼チャットは人狼・狂人のみ送れる
      if (isWolfChat && role !== 'werewolf') return;

      const gameResult = await query(
        'SELECT current_phase FROM games WHERE id = $1', [gameId]
      );
      const phase = gameResult.rows[0]?.current_phase;

      // イベントログに保存
      await logEvent(gameId, phase, 'chat', userId, null,
        { message, handleName: handle_name }, isWolfChat);

      // 配信先を決める
      const channel = isWolfChat ? `game:${gameId}:wolves` : `game:${gameId}`;
      io.to(channel).emit('chat_message', {
        userId,
        handleName: handle_name,
        message,
        isWolfChat,
        phase,
      });
    });

    // ─── 切断 ───
    socket.on('disconnect', () => {
      console.log(`切断: ${socket.id}`);
    });
  });

};

// ─── ゲームエンジンからSocket.ioを使うためのヘルパー ───
// ゲームエンジン（routes/games.ts）からこれを呼ぶ

export const broadcastPhaseChange = (
  io: Server, gameId: number,
  phase: string, day: number, phaseEndsAt: Date
) => {
  io.to(`game:${gameId}`).emit('phase_change', { phase, day, phaseEndsAt });
};

export const broadcastGameEnd = (io: Server, gameId: number, winner: string) => {
  io.to(`game:${gameId}`).emit('game_end', { winner });
};

export const broadcastPlayerDeath = (io: Server, gameId: number, userId: number) => {
  io.to(`game:${gameId}`).emit('player_died', { userId });
};