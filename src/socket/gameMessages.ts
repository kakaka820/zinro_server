// src/socket/gameMessages.ts — ゲーム内システムメッセージを一元管理
import { Server } from 'socket.io';
import { broadcastSystemMessage } from './systemMessages';

const toGame = (io: Server, gameId: number, message: string) =>
  broadcastSystemMessage(io, `game:${gameId}`, message);

const PHASE_LABELS: Record<string, string> = {
  day_discussion: '昼：議論',
  day_vote:       '昼：投票',
  night:          '夜',
};

export const msgGameStart = (io: Server, gameId: number) =>
  toGame(io, gameId, '── ゲームが開始されました ──');

export const msgPhaseChange = (io: Server, gameId: number, phase: string, day: number) =>
  toGame(io, gameId, `── ${PHASE_LABELS[phase] ?? phase}　${day}日目 ──`);

export const msgGameEnd = (io: Server, gameId: number, winner: string) => {
  const msg = winner === 'village' ? '🏘️ 村人陣営の勝利！' : '🐺 人狼陣営の勝利！';
  toGame(io, gameId, `── ${msg} ──`);
};

export const msgNightDeath = (io: Server, gameId: number, playerName: string) =>
  toGame(io, gameId, `🌙 「${playerName}」が無残にも死体で発見されました`);

export const msgNoDeathAtNight = (io: Server, gameId: number) =>
  toGame(io, gameId, '🛡️ 今夜は誰も死ななかった');

export const msgExecution = (io: Server, gameId: number, playerName: string) =>
  toGame(io, gameId, `⚔️ 「${playerName}」が処刑されました`);


// 投票結果サマリー（行の配列を受け取って1メッセージにまとめる）
export const msgVoteSummary = (
  io: Server,
  gameId: number,
  lines: string[]
) => {
  toGame(io, gameId, '【投票結果】');
  for (const line of lines) {
    toGame(io, gameId, line);
  }
};
