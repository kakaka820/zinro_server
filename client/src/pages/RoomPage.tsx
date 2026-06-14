// RoomPage.tsx — 待機室 + ゲーム画面を統合
import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import api from '../api/client';
import { useAuth } from '../hooks/useAuth';

// ── 型定義 ────────────────────────────────────────────────
type Member = {
  id: number; handle_name: string;
  is_ready?: boolean; is_spectator?: boolean; is_bot?: boolean;
};
type RoomDetail = {
  id: number; name: string; owner_id: number; status: string;
  max_players: number; current_game_id?: number; members: Member[];
};
type Player = {
  user_id: number; handle_name: string;
  is_alive: boolean; died_at_day: number | null;
};
type Game = {
  id: number; current_phase: string; current_day: number; status: string;
  winner_faction?: string; phase_ends_at: string | null; players: Player[];
};
type Message = {
  type?: 'chat' | 'system'; userId?: number; handleName?: string;
  message: string; isWolfChat?: boolean;
};

const PHASE_LABEL: Record<string, string> = {
  waiting:        '⏳ 開始前',
  day_discussion: '☀️ 昼：議論',
  day_vote:       '☀️ 昼：投票',
  execution:      '⚔️ 処刑',
  night:          '🌙 夜',
  game_over:      '🏁 ゲーム終了',
};

// ── コンポーネント ─────────────────────────────────────────
export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const roomIdNum = Number(roomId);

  // refs（ソケットハンドラー内で使う可変値）
  const socketRef        = useRef<Socket | null>(null);
  const userIdRef        = useRef<number | undefined>(undefined);
  const gameIdRef        = useRef<number | null>(null);   // game_started後に更新
  const skipLeaveRef     = useRef(false);
  const chatEndRef       = useRef<HTMLDivElement>(null);

  // ── 待機室 state ──
  const [room,     setRoom]     = useState<RoomDetail | null>(null);
  const [members,  setMembers]  = useState<Member[]>([]);
  const [starting, setStarting] = useState(false);

  // ── ゲーム state ──
  const [game,        setGame]        = useState<Game | null>(null);
  const [currentGameId, setCurrentGameId] = useState<number | null>(null);
  const [myRole,      setMyRole]      = useState<string | null>(null);
  const [voteTarget,  setVoteTarget]  = useState<number | null>(null);
  const [votedFor,    setVotedFor]    = useState<number | null>(null);
  const [nightTarget, setNightTarget] = useState<number | null>(null);
  const [seerResult,  setSeerResult]  = useState<string | null>(null);
  const [timeLeft,    setTimeLeft]    = useState<number | null>(null);
  const [actionDone,  setActionDone]  = useState(false);
  const [winner,      setWinner]      = useState<string | null>(null);
  const [isWolfChat,  setIsWolfChat]  = useState(false);
  const [myBet,       setMyBet]       = useState<string | null>(null);
  const [betError,    setBetError]    = useState('');

  // ── 共通 state ──
  const [messages,  setMessages]  = useState<Message[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [error,     setError]     = useState('');

  // ── 派生値 ──
  const phase      = game?.current_phase ?? 'waiting';
  const isInGame   = game !== null;

  // ── userIdRef 同期 ──
  useEffect(() => { userIdRef.current = user?.id; }, [user?.id]);

  // ── タイマー ──
  useEffect(() => {
    if (!game?.phase_ends_at) { setTimeLeft(null); return; }
    const tick = () => setTimeLeft(
      Math.max(0, Math.floor((new Date(game.phase_ends_at!).getTime() - Date.now()) / 1000))
    );
    tick();
    const t = setInterval(tick, 1000);
    return () => clearInterval(t);
  }, [game?.phase_ends_at]);

  // ── データ取得 ──
  const fetchRoom = async () => {
    try {
      const res = await api.get<RoomDetail>(`/api/rooms/${roomIdNum}`);
      setRoom(res.data);
      setMembers(res.data.members);
      if (res.data.status === 'in_game' && res.data.current_game_id) {
        await loadGame(res.data.current_game_id);
      }
    } catch { navigate('/lobby'); }
  };

  const loadGame = async (gid: number) => {
    gameIdRef.current = gid;
    setCurrentGameId(gid);
    try {
      const [gameRes, roleRes] = await Promise.all([
        api.get<Game>(`/api/games/${gid}`),
        api.get<{ role: string }>(`/api/games/${gid}/my-role`),
      ]);
      setGame(gameRes.data);
      if (gameRes.data.status === 'finished' && gameRes.data.winner_faction) {
        setWinner(gameRes.data.winner_faction);
      }
      setMyRole(roleRes.data.role);
    } catch {}
  };

  // ソケットハンドラーから呼ぶ用（refでgameIdを参照）
  const refreshGame = async () => {
    const gid = gameIdRef.current;
    if (!gid) return;
    try {
      const res = await api.get<Game>(`/api/games/${gid}`);
      setGame(res.data);
      if (res.data.status === 'finished' && res.data.winner_faction) {
        setWinner(res.data.winner_faction);
      }
    } catch {}
  };

  // ── Socket.io ──
  useEffect(() => {
    fetchRoom();

    socketRef.current = io(
      import.meta.env.VITE_SOCKET_URL || window.location.origin,
      { withCredentials: true }
    );

    // 再接続時に両方のルームに再参加
    socketRef.current.on('connect', () => {
      if (!userIdRef.current) return;
      socketRef.current?.emit('join_room', { roomId: roomIdNum, userId: userIdRef.current });
      if (gameIdRef.current) {
        socketRef.current?.emit('join_game', { gameId: gameIdRef.current, userId: userIdRef.current, isWolf: false });
      }
    });

    socketRef.current.on('system_message', ({ message }: { message: string }) =>
      setMessages(prev => [...prev, { type: 'system', message }])
    );
    socketRef.current.on('room_chat_message', (msg: { userId: number; handleName: string; message: string }) =>
      setMessages(prev => [...prev, { type: 'chat', ...msg }])
    );
    socketRef.current.on('chat_message', (msg: Message) =>
      setMessages(prev => [...prev, msg])
    );

    socketRef.current.on('room_updated', fetchRoom);

    socketRef.current.on('game_started', async (data: { gameId: number }) => {
      await loadGame(data.gameId);
      socketRef.current?.emit('join_game', {
        gameId: data.gameId,
        userId: userIdRef.current,
        isWolf: false,
      });
    });

    socketRef.current.on('phase_change', () => {
      refreshGame();
      setActionDone(false); setSeerResult(null);
      setVoteTarget(null); setVotedFor(null); setNightTarget(null);
    });
    socketRef.current.on('player_died', refreshGame);
    socketRef.current.on('game_end', ({ winner: w }: { winner: string }) => {
      setWinner(w);
      refreshGame();
    });

    return () => {
      if (!skipLeaveRef.current && userIdRef.current) {
        socketRef.current?.emit('leave_room', { roomId: roomIdNum, userId: userIdRef.current });
      }
      socketRef.current?.disconnect();
    };
  }, [roomIdNum]);

  // ── join_room（user確定後）──
  useEffect(() => {
    if (!user?.id || !socketRef.current) return;
    if (socketRef.current.connected) {
      socketRef.current.emit('join_room', { roomId: roomIdNum, userId: user.id });
    }
  }, [roomIdNum, user?.id]);

  // ── kicked ──
  useEffect(() => {
    if (!user?.id || !socketRef.current) return;
    const handleKicked = ({ userId: kickedId }: { userId: number }) => {
      if (kickedId === user.id) {
        skipLeaveRef.current = true;
        alert('キックされました');
        navigate('/lobby');
      }
    };
    socketRef.current.on('kicked', handleKicked);
    return () => { socketRef.current?.off('kicked', handleKicked); };
  }, [user?.id, roomIdNum]);

  // ── 自動スクロール ──
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  // ── アクション ──
  const leaveRoom = async () => {
    skipLeaveRef.current = true;
    socketRef.current?.emit('leave_room', { roomId: roomIdNum, userId: userIdRef.current });
    await api.post(`/api/rooms/${roomIdNum}/leave`);
    navigate('/lobby');
  };

  const sendChat = () => {
    if (!chatInput.trim() || !user) return;
    if (isInGame && currentGameId) {
      socketRef.current?.emit('chat', { gameId: currentGameId, userId: user.id, message: chatInput.trim(), isWolfChat });
    } else {
      socketRef.current?.emit('room_chat', { roomId: roomIdNum, userId: user.id, message: chatInput.trim() });
    }
    setChatInput('');
  };

  const vote = async () => {
    if (!voteTarget || !currentGameId) return;
    try {
      await api.post(`/api/games/${currentGameId}/vote`, { targetId: voteTarget });
      setVotedFor(voteTarget);
    } catch (err: unknown) { setError(err instanceof Error ? err.message : '投票に失敗しました'); }
  };

  const nightAction = async () => {
    if (!nightTarget || !currentGameId) return;
    try {
      const res = await api.post<{ result?: string }>(`/api/games/${currentGameId}/night-action`, { targetId: nightTarget });
      setActionDone(true);
      if (res.data.result) setSeerResult(res.data.result);
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'アクションに失敗しました'); }
  };

  const startGame = async () => {
    setStarting(true); setError('');
    try {
      // game_started ソケットイベントで処理するのでnavigateしない
      await api.post('/api/games/start', { roomId: roomIdNum });
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'ゲーム開始に失敗しました');
      setStarting(false);
    }
  };

  const advance = async () => {
    if (!currentGameId) return;
    await api.post(`/api/games/${currentGameId}/advance`);
    await refreshGame();
    setActionDone(false);
  };

  // ── 派生 ──
  const isOwner      = user?.id === room?.owner_id;
  const isLastMember = members.length === 1;
  const canStart     = isOwner && members.length >= 1;
  const me           = game?.players.find(p => p.user_id === user?.id);
  const alivePlayers = game?.players.filter(p => p.is_alive && p.user_id !== user?.id) ?? [];
  const isAlive      = me?.is_alive ?? false;
  const isWolf       = myRole === 'werewolf';

  if (!room) return <div className="container">読み込み中...</div>;

  // ─────────────────────────────────────────────────────────
  // 共通チャットエリア（待機室・ゲーム共用）
  // ─────────────────────────────────────────────────────────
  const chatArea = (
    <div>
      {isWolf && isAlive && phase === 'night' && (
        <div style={{ marginBottom: 6 }}>
          <button onClick={() => setIsWolfChat(!isWolfChat)}
            style={{ fontSize: 12, background: isWolfChat ? '#4a1a1a' : undefined, borderColor: isWolfChat ? '#aa4a4a' : undefined }}>
            {isWolfChat ? '🐺 人狼チャット中' : '💬 通常チャット'}
          </button>
        </div>
      )}
      <div style={{ height: 320, overflowY: 'auto', border: '1px solid #2a2a4a', padding: 8, marginBottom: 8, fontSize: 13 }}>
        {messages.length === 0 && <p style={{ color: '#555' }}>まだメッセージはありません</p>}
        {messages.map((m, i) => (
          <div key={i} style={{ marginBottom: 4 }}>
            {m.type === 'system' ? (
              <span style={{ color: '#666', fontSize: 11, display: 'block', textAlign: 'center' }}>{m.message}</span>
            ) : (
              <>
                {m.isWolfChat && <span style={{ color: '#aa4a4a', fontSize: 11 }}>[🐺] </span>}
                <span style={{ color: '#7ec8e3' }}>{m.handleName}：</span>
                <span>{m.message}</span>
              </>
            )}
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>
      {(!isInGame || (isAlive && phase !== 'game_over')) && (
        <div style={{ display: 'flex', gap: 6 }}>
          <input value={chatInput} onChange={e => setChatInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && sendChat()}
            placeholder="メッセージを入力..." style={{ flex: 1 }} />
          <button onClick={sendChat}>送信</button>
        </div>
      )}
      {isInGame && !isAlive && (
        <p style={{ color: '#555', fontSize: 12 }}>（死亡者は発言できません）</p>
      )}
    </div>
  );

  // ─────────────────────────────────────────────────────────
  // 待機室 UI
  // ─────────────────────────────────────────────────────────
  if (!isInGame) {
    return (
      <div className="container">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          borderBottom: '1px solid #4a4a7a', paddingBottom: 8, marginBottom: 16 }}>
          <div>
            <span style={{ fontSize: 16, marginRight: 8 }}>🚪 {room.name}</span>
            <span style={{ fontSize: 12, color: '#888' }}>{PHASE_LABEL['waiting']}</span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <button onClick={fetchRoom} style={{ fontSize: 12 }}>🔄</button>
            <button onClick={leaveRoom} style={{ fontSize: 12 }}>
              {isLastMember ? '村を閉じる' : '退室'}
            </button>
          </div>
        </div>

        {error && <p className="error" style={{ marginBottom: 12 }}>{error}</p>}

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px', gap: 12 }}>
          {chatArea}
          <div>
            <h2 style={{ fontSize: 14, color: '#aaa', marginBottom: 8 }}>
              参加者　{members.filter(m => !m.is_spectator).length} / {room.max_players}人
              {members.filter(m => m.is_spectator).length > 0 && `　観戦 ${members.filter(m => m.is_spectator).length}人`}
            </h2>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
              <tbody>
                {members.map((m, i) => (
                  <tr key={m.id} style={{ borderBottom: '1px solid #2a2a4a' }}>
                    <td style={{ padding: '6px 4px', color: '#aaa' }}>{i + 1}</td>
                    <td style={{ padding: '6px 4px' }}>
                      {m.handle_name}
                      {m.id === room.owner_id && <span style={{ color: '#f4c430', fontSize: 11, marginLeft: 4 }}>★オーナー</span>}
                      {m.is_spectator && <span style={{ color: '#888', fontSize: 11, marginLeft: 4 }}>👁 観戦</span>}
                      {m.is_bot && <span style={{ color: '#a78bfa', fontSize: 11, marginLeft: 4 }}>🤖</span>}
                      {m.id === user?.id && <span style={{ color: '#7ec8e3', fontSize: 11, marginLeft: 4 }}>(あなた)</span>}
                    </td>
                    <td style={{ padding: '6px 4px', textAlign: 'right' }}>
                      {isOwner && m.id !== user?.id && (
                        <button onClick={() => api.post(`/api/rooms/${roomIdNum}/kick`, { targetUserId: m.id }).catch(e => setError(String(e)))}
                          style={{ fontSize: 11, color: '#f87171', borderColor: '#7f1d1d', background: 'transparent' }}>
                          キック
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {isOwner && (
              <button onClick={() => api.post(`/api/rooms/${roomIdNum}/add-bot`).catch(e => setError(String(e)))}
                style={{ fontSize: 12, marginBottom: 8, display: 'block', width: '100%' }}>
                🤖 Bot を追加
              </button>
            )}
            {isOwner ? (
              <button onClick={startGame} disabled={!canStart || starting}
                style={{ width: '100%', padding: '6px 0', background: canStart ? '#4a2a7a' : undefined,
                  borderColor: canStart ? '#7a4aaa' : undefined, fontSize: 13 }}>
                {starting ? '開始中...' : 'ゲームを開始する'}
              </button>
            ) : (
              <p style={{ color: '#aaa', fontSize: 12 }}>オーナーがゲームを開始するのを待っています...</p>
            )}
          </div>
        </div>
      </div>
    );
  }

  // ─────────────────────────────────────────────────────────
  // ゲーム UI
  // ─────────────────────────────────────────────────────────
  return (
    <div className="container">
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
          <button onClick={refreshGame} style={{ fontSize: 11, color: '#aaa', borderColor: '#4a4a7a',
            background: 'transparent', padding: '2px 6px', marginLeft: 8 }}>🔄</button>
        </div>
        <div style={{ fontSize: 12, color: '#aaa' }}>
          あなた：<span style={{ color: '#f4c430' }}>{myRole ?? '...'}</span>
          {!isAlive && <span style={{ color: '#ff6b6b', marginLeft: 8 }}>（死亡）</span>}
        </div>
      </div>

      {error && <p className="error" style={{ marginBottom: 8 }}>{error}</p>}

      {myRole === 'spectator' && phase !== 'game_over' && (
        <div style={{ marginBottom: 8 }}>
          <button onClick={() => navigate('/lobby')} style={{ fontSize: 12, color: '#aaa', borderColor: '#4a4a7a', background: 'transparent' }}>
            ロビーに戻る
          </button>
        </div>
      )}

      {(winner || phase === 'game_over') && (
        <div style={{ background: '#2a1a4a', border: '1px solid #7a4aaa', padding: 12, marginBottom: 12, textAlign: 'center' }}>
          <p style={{ fontSize: 16, marginBottom: 8 }}>
            {(winner ?? game.winner_faction) === 'village' ? '🏘️ 村人陣営の勝利！' : '🐺 人狼陣営の勝利！'}
          </p>
          <button onClick={() => navigate('/lobby')}>ロビーに戻る</button>
          <button onClick={() => navigate(`/log/${currentGameId}`)} style={{ marginLeft: 8 }}>ログを見る</button>
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px', gap: 12 }}>
        {chatArea}
        <div>
          <h3 style={{ fontSize: 13, color: '#aaa', marginBottom: 6 }}>プレイヤー</h3>
          <div style={{ marginBottom: 12 }}>
            {game.players.map(p => (
              <div key={p.user_id} style={{ display: 'flex', alignItems: 'center',
                padding: '4px 0', borderBottom: '1px solid #2a2a4a', fontSize: 13, opacity: p.is_alive ? 1 : 0.4 }}>
                <span style={{ flex: 1 }}>
                  {p.handle_name}
                  {p.user_id === user?.id && <span style={{ color: '#7ec8e3' }}> ◀</span>}
                </span>
                {!p.is_alive && <span style={{ fontSize: 11, color: '#ff6b6b' }}>†{p.died_at_day}日目</span>}
              </div>
            ))}
          </div>

          {phase === 'day_vote' && isAlive && (
            <div>
              <p style={{ fontSize: 12, color: '#aaa', marginBottom: 6 }}>処刑する人を選んでください</p>
              <select value={voteTarget ?? ''} onChange={e => setVoteTarget(Number(e.target.value))} style={{ marginBottom: 6 }}>
                <option value="">-- 選ぶ --</option>
                {alivePlayers.map(p => <option key={p.user_id} value={p.user_id}>{p.handle_name}</option>)}
              </select>
              {votedFor && (
                <p style={{ fontSize: 12, color: '#7ec8e3', marginBottom: 6 }}>
                  現在の投票先：<strong>{game.players.find(p => p.user_id === votedFor)?.handle_name}</strong>（変更可能）
                </p>
              )}
              <button onClick={vote}>{votedFor ? '投票先を変更する' : '投票する'}</button>
            </div>
          )}

          {phase === 'night' && isAlive && !actionDone && ['werewolf', 'seer', 'knight'].includes(myRole ?? '') && (
            <div>
              <p style={{ fontSize: 12, color: '#aaa', marginBottom: 6 }}>
                {myRole === 'werewolf' && '🐺 誰を噛みますか？'}
                {myRole === 'seer'     && '🔮 誰を占いますか？'}
                {myRole === 'knight'   && '🛡️ 誰を守りますか？'}
              </p>
              <select value={nightTarget ?? ''} onChange={e => setNightTarget(Number(e.target.value))} style={{ marginBottom: 6 }}>
                <option value="">-- 選ぶ --</option>
                {alivePlayers.map(p => <option key={p.user_id} value={p.user_id}>{p.handle_name}</option>)}
              </select>
              <button onClick={nightAction} disabled={!nightTarget}>実行</button>
            </div>
          )}
          {phase === 'night' && actionDone && (
            <div>
              <p style={{ fontSize: 12, color: '#6bffb8' }}>✓ アクション済み</p>
              {seerResult && (
                <p style={{ fontSize: 13, marginTop: 6, color: seerResult === 'wolf' ? '#ff6b6b' : '#6bffb8' }}>
                  占い結果：{seerResult === 'wolf' ? '🐺 人狼です！' : '👤 人間です'}
                </p>
              )}
            </div>
          )}

          {myRole === 'spectator' && phase === 'day_discussion' && !myBet && (
            <div style={{ marginTop: 12, padding: 8, border: '1px solid #4a4a7a' }}>
              <p style={{ fontSize: 12, color: '#aaa', marginBottom: 6 }}>🎲 どちらが勝つ？</p>
              {betError && <p className="error" style={{ marginBottom: 6 }}>{betError}</p>}
              <div style={{ display: 'flex', gap: 6 }}>
                <button style={{ flex: 1, fontSize: 12 }} onClick={async () => {
                  try { await api.post('/api/bets', { gameId: currentGameId, betOn: 'village' }); setMyBet('village'); }
                  catch (e: unknown) { setBetError(e instanceof Error ? e.message : '賭けに失敗しました'); }
                }}>🏘️ 村人</button>
                <button style={{ flex: 1, fontSize: 12 }} onClick={async () => {
                  try { await api.post('/api/bets', { gameId: currentGameId, betOn: 'wolf' }); setMyBet('wolf'); }
                  catch (e: unknown) { setBetError(e instanceof Error ? e.message : '賭けに失敗しました'); }
                }}>🐺 人狼</button>
              </div>
            </div>
          )}
          {myRole === 'spectator' && myBet && (
            <p style={{ fontSize: 12, color: '#6bffb8', marginTop: 12 }}>
              ✓ {myBet === 'village' ? '🏘️ 村人陣営' : '🐺 人狼陣営'} に賭けました
            </p>
          )}

          {import.meta.env.DEV && (
            <div style={{ marginTop: 12, paddingTop: 8, borderTop: '1px solid #2a2a4a' }}>
              <button onClick={advance} style={{ fontSize: 11, color: '#555' }}>[DEV] フェーズ進行</button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}