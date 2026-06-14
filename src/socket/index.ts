// src/socket/index.ts

import { Server, Socket } from 'socket.io';
import { query } from '../db';
import { logEvent } from '../game/engine';
import { broadcastSystemMessage } from './systemMessages';
import { msgPhaseChange, msgGameEnd } from './gameMessages';
import { setupRoomChat } from './roomChat';

// ─── 役職チャンネル設定（拡張ポイント）───
// 夜フェーズ中に参加するチャンネルと送信可否を定義
// 新役職追加時はここにエントリを追加するだけでOK
type RoleChannelConfig = {
  channel: string;   // チャンネル名（例: 'wolves', 'sharing'）
  canSend: boolean;  // このチャンネルへの送信可否
};

const NIGHT_ROLE_CHANNELS: Record<string, RoleChannelConfig[]> = {
  werewolf: [{ channel: 'wolves', canSend: true }],
  madman:   [],  // 標準狂人：狼チャット不可
  seer:     [],
  medium:   [],
  knight:   [],
  villager: [],
  // 将来の拡張例（コメントアウトのまま残す）:
  // sharing_villager: [{ channel: 'sharing', canSend: true }],
  // listening_madman: [{ channel: 'wolves', canSend: false }], // 聴狂人：受信のみ
};

// ─── フェーズ×役職でチャットルーティングを決定 ───
type ChatRouting =
  | { type: 'public' }                            // game:${id} 全員
  | { type: 'role_channel'; channel: string }     // 役職チャンネル（夜のみ）
  | { type: 'self_only' };                        // 送信者のソケットのみ

  function getChatRouting(phase: string, role: string): ChatRouting {
  switch (phase) {
    case 'day_discussion':
    case 'game_over':
      return { type: 'public' };
    case 'day_vote':
    case 'execution':
      return { type: 'self_only' };
    case 'night': {
      const roleChannels = NIGHT_ROLE_CHANNELS[role] ?? [];
      const sendableChannel = roleChannels.find(c => c.canSend);
      if (sendableChannel) {
        return { type: 'role_channel', channel: sendableChannel.channel };
      }
      return { type: 'self_only' };
    }

    default:
      return { type: 'self_only' };
  }
}

export const setupSocket = (io: Server) => {

  io.on('connection', (socket: Socket) => {
    setupRoomChat(io, socket);
    console.log(`接続: ${socket.id}`);

    // ─── ルームに参加（待機室・観戦含む）───
    socket.on('join_room', async ({ roomId, userId }: { roomId: number; userId: number }) => {
      socket.join(`room:${roomId}`);
      // 入室を全員に通知
      const userResult = await query(
        'SELECT handle_name FROM users WHERE id = $1', [userId]
      );
      const handleName = userResult.rows[0]?.handle_name ?? '不明';
      io.to(`room:${roomId}`).emit('room_updated', {
        type: 'user_joined',
        handleName: userResult.rows[0]?.handle_name,
        userId,
      });
      broadcastSystemMessage(io, `room:${roomId}`, `${handleName}が入室しました`);
    });

    // ─── ルームから退出 ───
    socket.on('leave_room', async ({ roomId, userId }: { roomId: number; userId: number }) => {
  // async追加 + DB取得追加
  const userResult = await query(
    'SELECT handle_name FROM users WHERE id = $1', [userId]
  );
  const handleName = userResult.rows[0]?.handle_name ?? '不明';
  socket.leave(`room:${roomId}`);
  io.to(`room:${roomId}`).emit('room_updated', {
    type: 'user_left',
    userId,
  });
  broadcastSystemMessage(io, `room:${roomId}`, `「${handleName}」が退室しました`);
});

    // ─── ゲームルームに参加（ゲーム開始後）───
    socket.on('join_game', async ({ gameId, userId }: { gameId: number; userId: number }) => {
      socket.join(`game:${gameId}`);
      const result = await query(
        `SELECT role FROM game_players WHERE game_id = $1 AND user_id = $2`,
        [gameId, userId]
      );
      const role: string = result.rows[0]?.role ?? 'villager';
      const roleChannels = NIGHT_ROLE_CHANNELS[role] ?? [];

      // 役職に応じたチャンネルに参加（受信のみの役職も含む）
      for (const { channel } of roleChannels) {
        socket.join(`game:${gameId}:${channel}`);
      }

      // クライアントに参加チャンネル情報を通知
      socket.emit('joined_game', {
        role,
        channels: roleChannels.map(c => ({ channel: c.channel, canSend: c.canSend })),
      });
    });

    // ─── チャット送信 ───
    socket.on('chat', async ({
      gameId, userId, message,
    }: { gameId: number; userId: number; message: string }) => {
      if (!message?.trim() || message.length > 200) return;
      const playerResult = await query(
        `SELECT gp.role, gp.is_alive, u.handle_name
         FROM game_players gp
         JOIN users u ON gp.user_id = u.id
         WHERE gp.game_id = $1 AND gp.user_id = $2`,
        [gameId, userId]
      );
      if (playerResult.rows.length === 0) return;

      const { role, is_alive, handle_name } = playerResult.rows[0];
      if (!is_alive) return;

      const gameResult = await query('SELECT current_phase FROM games WHERE id = $1', [gameId]);
      const phase: string = gameResult.rows[0]?.current_phase;
      const routing = getChatRouting(phase, role);
      const isRoleChat = routing.type === 'role_channel';
      const channel = isRoleChat ? (routing as { type: 'role_channel'; channel: string }).channel : null;


      // イベントログに保存
      await logEvent(gameId, phase, 'chat', userId, null,
        { message, handleName: handle_name, channel },
        isRoleChat
      );
      const payload = {
        userId,
        handleName: handle_name,
        message,
        phase,
        channel,  // 'wolves' | 'sharing' | null(=公開)
        isWolfChat: channel === 'wolves',  // 後方互換性のため残す
      };

      switch (routing.type) {
        case 'public':
          io.to(`game:${gameId}`).emit('chat_message', payload);
          break;
        case 'role_channel':
          io.to(`game:${gameId}:${routing.channel}`).emit('chat_message', payload);
          break;
        case 'self_only':
          socket.emit('chat_message', payload);
          break;
      }
    });

    socket.on('disconnect', () => { /* ログはpino等で */ });
  });
};

// ─── ゲームエンジンからSocket.ioを使うためのヘルパー ───
export const broadcastPhaseChange = (
  io: Server, gameId: number, phase: string, day: number, phaseEndsAt: Date
) => {
  io.to(`game:${gameId}`).emit('phase_change', { phase, day, phaseEndsAt });
  msgPhaseChange(io, gameId, phase, day);
};
export const broadcastGameEnd = (io: Server, gameId: number, winner: string) => {
  io.to(`game:${gameId}`).emit('game_end', { winner });
  msgGameEnd(io, gameId, winner);
};

export const broadcastPlayerDeath = (io: Server, gameId: number, userId: number) => {
  io.to(`game:${gameId}`).emit('player_died', { userId });
};