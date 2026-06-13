// GamePage.tsx
import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import api from '../api/client';
import { useAuth } from '../hooks/useAuth';

type Player = {
  user_id: number;
  handle_name: string;
  is_alive: boolean;
  died_at_day: number | null;
};

type Game = {
  id: number;
  current_phase: string;
  current_day: number;
  status: string;
  winner_faction?: string;
  phase_ends_at: string | null;
  players: Player[];
};

type ChatMessage = {
  userId: number;
  handleName: string;
  message: string;
  isWolfChat: boolean;
  phase: string;
};

const PHASE_LABEL: Record<string, string> = {
  day_discussion: '☀️ 昼：議論',
  day_vote:       '☀️ 昼：投票',
  night:          '🌙 夜',
  game_over:      '🏁 ゲーム終了',
};

export default function GamePage() {
  const { gameId } = useParams<{ gameId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const socketRef = useRef<Socket | null>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const [game, setGame] = useState<Game | null>(null);
  const [myRole, setMyRole] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isWolfChat, setIsWolfChat] = useState(false);
  const [voteTarget, setVoteTarget] = useState<number | null>(null);
  const [nightTarget, setNightTarget] = useState<number | null>(null);
  const [seerResult, setSeerResult] = useState<string | null>(null);
  const [timeLeft, setTimeLeft] = useState<number | null>(null);
  const [actionDone, setActionDone] = useState(false);
  const [winner, setWinner] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [myBet, setMyBet] = useState<string | null>(null);
  const [betError, setBetError] = useState('');

  const id = Number(gameId);

  const fetchGame = async () => {
    const res = await api.get<Game>(`/api/games/${id}`);
    setGame(res.data);
    // リロード後もゲーム終了状態を復元
    if (res.data.status === 'finished' && res.data.winner_faction) {
    setWinner(res.data.winner_faction);
  }
  };

  const fetchMyRole = async () => {
    try {
      const res = await api.get<{ role: string }>(`/api/games/${id}/my-role`);
      setMyRole(res.data.role);
    } catch {
      setMyRole('spectator');
    }
  };

  // ─── タイマー ───
  useEffect(() => {
    if (!game?.phase_ends_at) { setTimeLeft(null); return; }
    const tick = () => {
      const diff = Math.max(0, Math.floor(
        (new Date(game.phase_ends_at!).getTime() - Date.now()) / 1000
      ));
      setTimeLeft(diff);
    };
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [game?.phase_ends_at]);

  // ─── Socket.io + 初期ロード ───
  useEffect(() => {
    fetchGame();
    fetchMyRole();

    socketRef.current = io(
      import.meta.env.VITE_SOCKET_URL || window.location.origin,
      { withCredentials: true }
    );

    socketRef.current.emit('join_game', {
      gameId: id,
      userId: user?.id,
      isWolf: false, // サーバー側で判断するのが本来だが今は簡易実装
    });

    socketRef.current.on('chat_message', (msg: ChatMessage) => {
      setMessages(prev => [...prev, msg]);
    });

    socketRef.current.on('phase_change', () => {
      fetchGame();
      setActionDone(false);
      setSeerResult(null);
      setVoteTarget(null);
      setNightTarget(null);
    });

    socketRef.current.on('player_died', () => {
      fetchGame();
    });

    socketRef.current.on('game_end', ({ winner }: { winner: string }) => {
      setWinner(winner);
      fetchGame();
    });

    return () => { socketRef.current?.disconnect(); };
  }, [id]);

  // チャット末尾に自動スクロール
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ─── チャット送信 ───
  const sendChat = () => {
    if (!chatInput.trim() || !user) return;
    socketRef.current?.emit('chat', {
      gameId: id,
      userId: user.id,
      message: chatInput.trim(),
      isWolfChat,
    });
    setChatInput('');
  };

  // ─── 投票 ───
  const vote = async () => {
    if (!voteTarget) return;
    try {
      await api.post(`/api/games/${id}/vote`, { targetId: voteTarget });
      setActionDone(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '投票に失敗しました');
    }
  };

  // ─── 夜アクション ───
  const nightAction = async () => {
    if (!nightTarget) return;
    try {
      const res = await api.post<{ result?: string }>(`/api/games/${id}/night-action`, {
        targetId: nightTarget,
      });
      setActionDone(true);
      if (res.data.result) setSeerResult(res.data.result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'アクションに失敗しました');
    }
  };

  // ─── フェーズ進行（開発用）───
  const advance = async () => {
    await api.post(`/api/games/${id}/advance`);
    await fetchGame();
    setActionDone(false);
  };

  if (!game) return <div className="container">読み込み中...</div>;

  const me = game.players.find(p => p.user_id === user?.id);
  const alivePlayers = game.players.filter(p => p.is_alive && p.user_id !== user?.id);
  const phase = game.current_phase;
  const isAlive = me?.is_alive ?? false;
  const isWolf = myRole === 'werewolf';

  return (
    <div className="container">
      {/* ─── ヘッダー ─── */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        borderBottom: '1px solid #4a4a7a', paddingBottom: 8, marginBottom: 12 }}>
        <div>
          <span style={{ fontSize: 16, marginRight: 12 }}>
            {PHASE_LABEL[phase] ?? phase}　{game.current_day}日目
          </span>
          {timeLeft !== null && (
            <span style={{ color: timeLeft < 30 ? '#ff6b6b' : '#aaa', fontSize: 13 }}>
              残り {timeLeft}秒
            </span>
          )}
        </div>
        <div style={{ fontSize: 12, color: '#aaa' }}>
          あなた：<span style={{ color: '#f4c430' }}>{myRole ?? '...'}</span>
          {!isAlive && <span style={{ color: '#ff6b6b', marginLeft: 8 }}>（死亡）</span>}
        </div>
      </div>

      {error && <p className="error" style={{ marginBottom: 8 }}>{error}</p>}
      
      {/* 死亡者・観戦者は常にロビーへ戻れる */}
      {(!isAlive || myRole === 'spectator') && phase !== 'game_over' && (
        <div style={{ marginBottom: 8 }}>
          <button
            onClick={() => navigate('/lobby')}
            style={{ fontSize: 12, color: '#aaa', borderColor: '#4a4a7a', background: 'transparent' }}
          >
            ロビーに戻る
          </button>
        </div>
      )}

      {/* ─── ゲーム終了バナー ─── */}
      
      {(winner || phase === 'game_over') && (
          <div style={{ background: '#2a1a4a', border: '1px solid #7a4aaa',
            padding: 12, marginBottom: 12, textAlign: 'center' }}>
            <p style={{ fontSize: 16, marginBottom: 8 }}>
              {(winner ?? game?.winner_faction) === 'village'
                ? '🏘️ 村人陣営の勝利！'
                : '🐺 人狼陣営の勝利！'}
            </p>
            <button onClick={() => navigate('/lobby')}>ロビーに戻る</button>
            <button onClick={() => navigate(`/log/${id}`)} style={{ marginLeft: 8 }}>
              ログを見る
            </button>
          </div>
        )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px', gap: 12 }}>

        {/* ─── 左：チャット ─── */}
        <div>
          {/* 人狼チャット切替 */}
          {isWolf && isAlive && phase === 'night' && (
            <div style={{ marginBottom: 6 }}>
              <button
                onClick={() => setIsWolfChat(!isWolfChat)}
                style={{ fontSize: 12, background: isWolfChat ? '#4a1a1a' : undefined,
                  borderColor: isWolfChat ? '#aa4a4a' : undefined }}
              >
                {isWolfChat ? '🐺 人狼チャット中' : '💬 通常チャット'}
              </button>
            </div>
          )}

          {/* メッセージログ */}
          <div style={{ height: 320, overflowY: 'auto', border: '1px solid #2a2a4a',
            padding: 8, marginBottom: 8, fontSize: 13 }}>
            {messages.length === 0 && (
              <p style={{ color: '#555' }}>まだメッセージはありません</p>
            )}
            {messages.map((m, i) => (
              <div key={i} style={{ marginBottom: 4 }}>
                {m.isWolfChat && (
                  <span style={{ color: '#aa4a4a', fontSize: 11 }}>[🐺] </span>
                )}
                <span style={{ color: '#7ec8e3' }}>{m.handleName}：</span>
                <span>{m.message}</span>
              </div>
            ))}
            <div ref={chatEndRef} />
          </div>

          {/* 入力欄 */}
          {isAlive && phase !== 'game_over' && (
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                value={chatInput}
                onChange={e => setChatInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && sendChat()}
                placeholder="メッセージを入力..."
                style={{ flex: 1 }}
              />
              <button onClick={sendChat}>送信</button>
            </div>
          )}
          {!isAlive && (
            <p style={{ color: '#555', fontSize: 12 }}>（死亡者は発言できません）</p>
          )}
        </div>

        {/* ─── 右：プレイヤー一覧 + アクション ─── */}
        <div>
          <h3 style={{ fontSize: 13, color: '#aaa', marginBottom: 6 }}>プレイヤー</h3>
          <div style={{ marginBottom: 12 }}>
            {game.players.map(p => (
              <div key={p.user_id} style={{ display: 'flex', alignItems: 'center',
                padding: '4px 0', borderBottom: '1px solid #2a2a4a', fontSize: 13,
                opacity: p.is_alive ? 1 : 0.4 }}>
                <span style={{ flex: 1 }}>
                  {p.handle_name}
                  {p.user_id === user?.id && <span style={{ color: '#7ec8e3' }}> ◀</span>}
                </span>
                {!p.is_alive && <span style={{ fontSize: 11, color: '#ff6b6b' }}>†{p.died_at_day}日目</span>}
              </div>
            ))}
          </div>

          {/* ─── 投票フェーズ ─── */}
          {phase === 'day_vote' && isAlive && !actionDone && (
            <div>
              <p style={{ fontSize: 12, color: '#aaa', marginBottom: 6 }}>処刑する人を選んでください</p>
              <select
                value={voteTarget ?? ''}
                onChange={e => setVoteTarget(Number(e.target.value))}
                style={{ marginBottom: 6 }}
              >
                <option value="">-- 選ぶ --</option>
                {alivePlayers.map(p => (
                  <option key={p.user_id} value={p.user_id}>{p.handle_name}</option>
                ))}
              </select>
              <button onClick={vote} disabled={!voteTarget}>投票する</button>
            </div>
          )}
          {phase === 'day_vote' && actionDone && (
            <p style={{ fontSize: 12, color: '#6bffb8' }}>✓ 投票済み</p>
          )}

          {/* ─── 夜フェーズ（特殊役職）─── */}
          {phase === 'night' && isAlive && !actionDone &&
            ['werewolf','seer','knight'].includes(myRole ?? '') && (
            <div>
              <p style={{ fontSize: 12, color: '#aaa', marginBottom: 6 }}>
                {myRole === 'werewolf' && '🐺 誰を噛みますか？'}
                {myRole === 'seer'     && '🔮 誰を占いますか？'}
                {myRole === 'knight'   && '🛡️ 誰を守りますか？'}
              </p>
              <select
                value={nightTarget ?? ''}
                onChange={e => setNightTarget(Number(e.target.value))}
                style={{ marginBottom: 6 }}
              >
                <option value="">-- 選ぶ --</option>
                {alivePlayers.map(p => (
                  <option key={p.user_id} value={p.user_id}>{p.handle_name}</option>
                ))}
              </select>
              <button onClick={nightAction} disabled={!nightTarget}>実行</button>
            </div>
          )}
          {phase === 'night' && actionDone && (
            <div>
              <p style={{ fontSize: 12, color: '#6bffb8' }}>✓ アクション済み</p>
              {seerResult && (
                <p style={{ fontSize: 13, marginTop: 6,
                  color: seerResult === 'wolf' ? '#ff6b6b' : '#6bffb8' }}>
                  占い結果：{seerResult === 'wolf' ? '🐺 人狼です！' : '👤 人間です'}
                </p>
              )}
            </div>
          )}

          {/* ─── 観戦者：賭けUI ─── */}
{myRole === 'spectator' && phase === 'day_discussion' && !myBet && (
  <div style={{ marginTop: 12, padding: 8, border: '1px solid #4a4a7a' }}>
    <p style={{ fontSize: 12, color: '#aaa', marginBottom: 6 }}>🎲 どちらが勝つ？</p>
    {betError && <p className="error" style={{ marginBottom: 6 }}>{betError}</p>}
    <div style={{ display: 'flex', gap: 6 }}>
      <button style={{ flex: 1, fontSize: 12 }} onClick={async () => {
        try {
          await api.post('/api/bets', { gameId: id, betOn: 'village' });
          setMyBet('village');
        } catch (e: unknown) {
          setBetError(e instanceof Error ? e.message : '賭けに失敗しました');
        }
      }}>🏘️ 村人</button>
      <button style={{ flex: 1, fontSize: 12 }} onClick={async () => {
        try {
          await api.post('/api/bets', { gameId: id, betOn: 'wolf' });
          setMyBet('wolf');
        } catch (e: unknown) {
          setBetError(e instanceof Error ? e.message : '賭けに失敗しました');
        }
      }}>🐺 人狼</button>
    </div>
  </div>
)}
{myRole === 'spectator' && myBet && (
  <p style={{ fontSize: 12, color: '#6bffb8', marginTop: 12 }}>
    ✓ {myBet === 'village' ? '🏘️ 村人陣営' : '🐺 人狼陣営'} に賭けました
  </p>
)}

          {/* ─── 開発用：フェーズ進行ボタン ─── */}
          {import.meta.env.DEV && (
            <div style={{ marginTop: 12, paddingTop: 8, borderTop: '1px solid #2a2a4a' }}>
              <button onClick={advance} style={{ fontSize: 11, color: '#555' }}>
                [DEV] フェーズ進行
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}