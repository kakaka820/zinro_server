// src/socket/systemMessages.ts
import { Server } from 'socket.io';

export const broadcastSystemMessage = (
  io: Server,
  channel: string,
  message: string
) => {
  io.to(channel).emit('system_message', { message });
};