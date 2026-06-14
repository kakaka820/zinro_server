// src/game/engine.ts


import { query } from '../db';

// ─── 役職の定義 ───
export const ROLES = {
  villager: { team: 'village', label: '村人' },
  werewolf: { team: 'wolf',    label: '人狼' },
  seer:     { team: 'village', label: '占い師' },
  medium:   { team: 'village', label: '霊媒師' },
  knight:   { team: 'village', label: '騎士' },
  madman:   { team: 'wolf',    label: '狂人' },
} as const;

export type RoleName = keyof typeof ROLES;

// 占い結果：狂人は「人間」に見える
export const getSeerResult = (role: RoleName): 'wolf' | 'human' => {
  return role === 'werewolf' ? 'wolf' : 'human';
};

// ─── イベントログ記録 ───
export const logEvent = async (
  gameId: number,
  phase: string,
  eventType: string,
  actorId: number | null,
  targetId: number | null,
  data: object | null,
  isWolfOnly: boolean = false
) => {
  await query(
    `INSERT INTO game_events (game_id, phase, event_type, actor_id, target_id, data, is_wolf_only)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [gameId, phase, eventType, actorId, targetId, data ? JSON.stringify(data) : null, isWolfOnly]
  );
};

// ─── ゲーム開始 ───
export const startGame = async (roomId: number) => {
  // ルーム情報取得
  const roomResult = await query('SELECT * FROM rooms WHERE id = $1', [roomId]);
  const room = roomResult.rows[0];
  if (!room || room.status !== 'waiting') throw new Error('ルームが待機中ではありません');

  // 参加者取得（観戦者を除く）
  const membersResult = await query(
    `SELECT user_id FROM room_members WHERE room_id = $1 AND is_spectator = FALSE`,
    [roomId]
  );
  const members: { user_id: number }[] = membersResult.rows;

  // 役職を展開（role_config から人数分の配列を作る）
  // 例: {werewolf:2, seer:1, villager:3} → ['werewolf','werewolf','seer','villager','villager','villager']

  //要修正（メモ）
  let roleConfig: Record<string, number> = room.role_config;

// roleConfigが空なら人数に合わせて自動設定
if (!roleConfig || Object.keys(roleConfig).length === 0) {
  const n = members.length;
  if      (n === 1)  roleConfig = { villager: 1 };                                           // テスト用
  else if (n === 5)  roleConfig = { werewolf: 1, seer: 1, villager: 3 };
  else if (n === 6)  roleConfig = { werewolf: 1, madman: 1, seer: 1, villager: 3 };
  else if (n === 7)  roleConfig = { werewolf: 2, seer: 1, villager: 4 };
  else if (n === 8)  roleConfig = { werewolf: 2, madman: 1, seer: 1, villager: 4 };
  else if (n === 9)  roleConfig = { werewolf: 2, madman: 1, seer: 1, knight: 1, villager: 4 };
  else if (n === 10) roleConfig = { werewolf: 2, madman: 1, seer: 1, knight: 1, villager: 5 };
  else if (n <= 13)  roleConfig = { werewolf: 3, madman: 1, seer: 1, knight: 1, medium: 1, villager: n - 7 };
  else               roleConfig = { werewolf: 4, madman: 1, seer: 1, knight: 1, medium: 1, villager: n - 8 };
}

const rolePool: RoleName[] = [];
for (const [role, count] of Object.entries(roleConfig)) {
  for (let i = 0; i < count; i++) rolePool.push(role as RoleName);
}

if (rolePool.length !== members.length) {
  throw new Error(`役職の合計(${rolePool.length})と参加者数(${members.length})が一致しません`);
}


  // シャッフル
  const shuffledRoles = rolePool.sort(() => Math.random() - 0.5);

  // phase_ends_at（昼フェーズの終了時刻）
  const phaseEndsAt = new Date(Date.now() + 300 * 1000); // 300秒後

  // ゲームレコード作成
  const gameResult = await query(
    `INSERT INTO games (room_id, current_phase, current_day, phase_ends_at)
     VALUES ($1, 'day_discussion', 1, $2) RETURNING *`,
    [roomId, phaseEndsAt]
  );
  const game = gameResult.rows[0];

  // game_players に役職を書き込む
  for (let i = 0; i < members.length; i++) {
    await query(
      `INSERT INTO game_players (game_id, user_id, role) VALUES ($1, $2, $3)`,
      [game.id, members[i].user_id, shuffledRoles[i]]
    );
    // 役職通知をイベントログに（本人だけに見える形でdataに入れる）
    await logEvent(game.id, 'day_discussion', 'role_assign',
      members[i].user_id, null, { role: shuffledRoles[i] }, false);
  }

  // 人狼同士はお互いを知る → イベントログに記録（wolf_onlyフラグ）
  const wolves = members.filter((_, i) => shuffledRoles[i] === 'werewolf');
  const wolfIds = wolves.map(w => w.user_id);
  await logEvent(game.id, 'day_discussion', 'wolf_reveal',
    null, null, { wolfIds }, true); // is_wolf_only = true

  // ルームのステータスを更新
  await query(`UPDATE rooms SET status = 'in_game' WHERE id = $1`, [roomId]);
  await logEvent(game.id, 'day_discussion', 'game_start', null, null, null);

  return game;
};

// ─── 勝利条件チェック ───
export const checkWinCondition = async (gameId: number): Promise<string | null> => {
  const result = await query(
    `SELECT role, is_alive FROM game_players WHERE game_id = $1`,
    [gameId]
  );
  const players: { role: RoleName; is_alive: boolean }[] = result.rows;
  const alive = players.filter(p => p.is_alive);

  const aliveWolves  = alive.filter(p => p.role === 'werewolf').length;
  const aliveVillage = alive.filter(p => p.role !== 'werewolf' && p.role !== 'madman').length;

  // 人狼が全員死んだ → 村勝利
  if (aliveWolves === 0) return 'village';
  // 人狼 ≥ 村人陣営 → 狼勝利
  if (aliveWolves >= aliveVillage) return 'wolf';

  return null; // まだ決着なし
};

// ─── フェーズ切替 ───
export const advancePhase = async (gameId: number) => {
  const gameResult = await query('SELECT * FROM games WHERE id = $1', [gameId]);
  const game = gameResult.rows[0];

  let nextPhase: string;
  let nextDay = game.current_day;
  let durationSec: number;

  switch (game.current_phase) {
    case 'day_discussion':
      nextPhase = 'day_vote';
      durationSec = 60; // 投票フェーズは60秒
      break;
    case 'day_vote':
      nextPhase = 'night';
      durationSec = 180;
      break;
    case 'night':
      nextPhase = 'day_discussion';
      nextDay = game.current_day + 1;
      durationSec = 300; // 昼300秒
      break;
    default:
      throw new Error('不明なフェーズ');
  }

  const phaseEndsAt = new Date(Date.now() + durationSec * 1000);
  await query(
    `UPDATE games SET current_phase = $1, current_day = $2, phase_ends_at = $3 WHERE id = $4`,
    [nextPhase, nextDay, phaseEndsAt, gameId]
  );
  await logEvent(gameId, nextPhase, 'phase_change', null, null,
    { from: game.current_phase, to: nextPhase, day: nextDay });

  return { nextPhase, nextDay, phaseEndsAt };
};

// ─── 夜アクション処理 ───
export const resolveNight = async (gameId: number) => {
  const gameResult = await query('SELECT current_day FROM games WHERE id = $1', [gameId]);
  const { current_day } = gameResult.rows[0];

  // その夜のアクションを取得
  const actions = await query(
    `SELECT * FROM game_events
     WHERE game_id = $1 AND phase = 'night' AND (data->>'day')::int = $2`,
    [gameId, current_day]
  );

  let killTarget: number | null = null;
  let guardTarget: number | null = null;

  for (const action of actions.rows) {
    if (action.event_type === 'kill_action') killTarget = action.target_id;
    if (action.event_type === 'guard_action') guardTarget = action.target_id;
  }

  // 護衛成功チェック
  if (killTarget && killTarget === guardTarget) {
    await logEvent(gameId, 'night', 'guard_success', null, guardTarget, null);
    killTarget = null; // 護衛成功 → 死なない
  }

  // 処理：誰かが死ぬ
  if (killTarget) {
    await query(
      `UPDATE game_players SET is_alive = FALSE, died_at_day = $1
       WHERE game_id = $2 AND user_id = $3`,
      [current_day, gameId, killTarget]
    );
    await logEvent(gameId, 'night', 'kill_result', null, killTarget,
      { day: current_day });
  }

  return { killTarget, guardTarget };
};