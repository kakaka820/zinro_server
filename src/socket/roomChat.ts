// src/socket/roomChat.ts
import { Server, Socket } from 'socket.io';
import { query } from '../db';

export const setupRoomChat = (io: Server, socket: Socket) => {
  socket.on('room_chat', async ({
    roomId, userId, message
  }: { roomId: number; userId: number; message: string }) => {
    if (!message || message.trim().length === 0) return;
    if (message.length > 200) return;

    const userResult = await query(
      `SELECT u.handle_name FROM room_members rm
       JOIN users u ON rm.user_id = u.id
       WHERE rm.room_id = $1 AND rm.user_id = $2`,
      [roomId, userId]
    );
    if (userResult.rows.length === 0) return;

    io.to(`room:${roomId}`).emit('room_chat_message', {
      userId,
      handleName: userResult.rows[0].handle_name,
      message: message.trim(),
      timestamp: new Date(),
    });
  });
};