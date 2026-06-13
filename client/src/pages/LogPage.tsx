// LogPage.tsx
import { useState, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import api from '../api/client';

type GameEvent = {
  id: number;
  phase: string;
  event_type: string;
  actor_id: number | null;
  target_id: number | null;
  data: Record<string, unknown> | null;
  is_wolf_only: boolean;
  created_at: string;
  actor_name?: string;
  target_name?: string;
};

type GameSummary = {
  id: number;
  current_day: number;
  winner_faction: string | null;
  status: string;
  players: { user_id: number; handle_name: string; role: string; is_alive: boolean }[];
};

const EVENT_LABEL: Record<string, string> = {
  game_start:     'ゲーム開始',
  phase_change:   'フェーズ変更',
  vote:           '投票',
  kill_result:    '襲撃',
  guard_success:  '護衛成功',
  seer_action:    '占い',
  execution:      '処刑',
  game_end:       'ゲーム終了',
  chat:           'チャット',
  role_assign:    '役職配布',
};

const PHASE_LABEL: Record<string, string> = {
  day_discussion: '昼・議論',
  day_vote:       '昼・投票',
  execution:      '処刑',
  night:          '夜',
  game_over:      '終了',
};

const ROLE_LABEL: Record<string, string> = {
  villager: '村人', werewolf: '人狼', seer: '占い師',
  medium: '霊媒師', knight: '騎士', madman: '狂人',
};

export default function LogPage() {
  const { gameId } = useParams<{ gameId: string }>();
  const navigate = useNavigate();
  const [game, setGame] = useState<GameSummary | null>(null);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [filter, setFilter] = useState<string>('all');

  useEffect(() => {
    const id = Number(gameId);

    api.get<GameSummary>(`/api/games/${id}`)
      .then(res => setGame(res.data));

    api.get<GameEvent[]>(`/api/games/${id}/log`)
      .then(res => setEvents(res.data));
  }, [gameId]);

  const filtered = filter === 'all'
    ? events.filter(e => !e.is_wolf_only)
    : events.filter(e => e.event_type === filter);

  if (!game) return <div className="container">読み込み中...</div>;

  return (
    <div className="container">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        borderBottom: '1px solid #4a4a7a', paddingBottom: 8, marginBottom: 16 }}>
        <h1 style={{ fontSize: 18 }}>📜 ゲームログ #{gameId}</h1>
        <button onClick={() => navigate('/lobby')}>ロビーへ戻る</button>
      </div>

      {/* 結果サマリー */}
      <div style={{ background: '#2a1a4a', border: '1px solid #7a4aaa',
        padding: 12, marginBottom: 16 }}>
        <p style={{ fontSize: 15, marginBottom: 8 }}>
          {game.winner_faction === 'village' ? '🏘️ 村人陣営の勝利' :
           game.winner_faction === 'wolf'    ? '🐺 人狼陣営の勝利' : '試合中'}
          　{game.current_day}日目終了
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {game.players?.map(p => (
            <span key={p.user_id} style={{
              fontSize: 12, padding: '2px 8px',
              border: '1px solid',
              borderColor: p.is_alive ? '#4a4a7a' : '#2a2a4a',
              color: p.is_alive ? '#e0e0e0' : '#555',
              background: p.role === 'werewolf' ? '#2a1a1a' :
                          p.role === 'madman'   ? '#2a1a1a' : '#1a1a2e',
            }}>
              {p.handle_name}（{ROLE_LABEL[p.role] ?? p.role}）
              {!p.is_alive && ' †'}
            </span>
          ))}
        </div>
      </div>

      {/* フィルター */}
      <div style={{ display: 'flex', gap: 6, marginBottom: 12, flexWrap: 'wrap' }}>
        {['all','chat','vote','kill_result','guard_success','seer_action'].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            style={{ fontSize: 12, background: filter === f ? '#3a3a6a' : undefined }}>
            {f === 'all' ? '全て' : EVENT_LABEL[f] ?? f}
          </button>
        ))}
      </div>

      {/* イベント一覧 */}
      <div style={{ fontSize: 13 }}>
        {filtered.map(e => (
          <div key={e.id} style={{ display: 'flex', gap: 12, padding: '5px 0',
            borderBottom: '1px solid #1a1a2e' }}>
            <span style={{ color: '#555', minWidth: 70 }}>
              {PHASE_LABEL[e.phase] ?? e.phase}
            </span>
            <span style={{ color: '#7ec8e3', minWidth: 80 }}>
              {EVENT_LABEL[e.event_type] ?? e.event_type}
            </span>
            <span style={{ flex: 1 }}>
              {e.event_type === 'chat' && e.data &&
                `${e.actor_name ?? '?'}：${e.data.message as string}`}
              {e.event_type === 'vote' &&
                `${e.actor_name ?? '?'} → ${e.target_name ?? '?'}`}
              {e.event_type === 'kill_result' &&
                `${e.target_name ?? '?'} が襲撃された`}
              {e.event_type === 'guard_success' &&
                `護衛成功`}
              {e.event_type === 'execution' &&
                `${e.target_name ?? '?'} が処刑された`}
              {e.event_type === 'game_end' && e.data &&
                `勝者：${e.data.winner as string}`}
            </span>
          </div>
        ))}
        {filtered.length === 0 && (
          <p style={{ color: '#555' }}>ログがありません</p>
        )}
      </div>
    </div>
  );
}