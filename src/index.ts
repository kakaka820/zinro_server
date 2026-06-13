//src/index.ts


import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import session from 'express-session';
import cors from 'cors';
import dotenv from 'dotenv';
import { pool } from './db';
import { authRouter } from './routes/auth';
import { roomsRouter } from './routes/rooms';
import { setupSocket } from './socket/index';
import { createGamesRouter } from './routes/games';
import { betsRouter } from './routes/bets';
import { resumeActiveTimers } from './game/timer';
import path from 'path';



dotenv.config();

const app = express();
const httpServer = createServer(app);


if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, '../client/dist')));
  app.use((_req, res) => {
  res.sendFile(path.join(__dirname, '../client/dist/index.html'));
});
}


// Socket.io セットアップ
const io = new Server(httpServer, {
  cors: {
    origin: process.env.FRONTEND_URL || 'http://localhost:5173',
    credentials: true,
  },
});

// ミドルウェア
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7日間
  },
}));

// ヘルスチェック
app.get('/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: 'connected' });
  } catch (e) {
    res.status(500).json({ status: 'error', db: 'disconnected' });
  }
});

// 認証ルート
   app.use('/api/auth', authRouter);

//  ルームルート
   app.use('/api/rooms', roomsRouter);
   app.use('/api/games', createGamesRouter(io));

   app.use('/api/bets', betsRouter);

// Socket.io 接続イベント
setupSocket(io);
resumeActiveTimers(io).catch(console.error);

// サーバー起動
const PORT = process.env.PORT || 3001;
httpServer.listen(PORT, () => {
  console.log(`サーバー起動: http://localhost:${PORT}`);
  console.log(`ヘルスチェック: http://localhost:${PORT}/health`);
});
