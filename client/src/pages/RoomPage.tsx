// RoomPage.tsx
import { useState, useEffect, useRef } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { io, Socket } from 'socket.io-client';
import api from '../api/client';
import { useAuth } from '../hooks/useAuth';

type Member = {
  id: number;
  handle_name: string;
  is_ready?: boolean;
  is_spectator?: boolean;
  is_bot?: boolean;
};

type RoomDetail = {
  id: number;
  name: string;
  owner_id: number;
  status: string;
  max_players: number;
  current_game_id?: number;
  members: Member[];
};

type ChatEntry =
  | { type: 'chat'; userId: number; handleName: string; message: string }
  | { type: 'system'; message: string };

export default function RoomPage() {
  const { roomId } = useParams<{ roomId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const socketRef = useRef<Socket | null>(null);

  const [room, setRoom] = useState<RoomDetail | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [error, setError] = useState('');
  const [starting, setStarting] = useState(false);
  const [messages, setMessages] = useState<ChatEntry[]>([]);
  const [chatInput, setChatInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  const id = Number(roomId);

  // ─── ルーム情報取得 ───
  const fetchRoom = async () => {
  try {
    const res = await api.get<RoomDetail>(`/api/rooms/${id}`);
    setRoom(res.data);
    setMembers(res.data.members);
    // リロード時にすでにゲームが始まっていたら遷移
    if (res.data.status === 'in_game' && res.data.current_game_id) {
      navigate(`/game/${res.data.current_game_id}`);
      return;
    }
  } catch {
    // 村が見つからない（削除済み等）→ ロビーへ
    navigate('/lobby');
  }
};

  // ─── Socket.io 接続 ───
  useEffect(() => {
    fetchRoom();

    socketRef.current = io(
      import.meta.env.VITE_SOCKET_URL || window.location.origin,
      { withCredentials: true }
    );

    socketRef.current.emit('join_room', { roomId: id, userId: user?.id });

    socketRef.current.on('system_message', ({ message }: { message: string }) => {
    setMessages(prev => [...prev, { type: 'system', message }]);
  });

    socketRef.current.on('room_chat_message', (msg: { userId: number; handleName: string; message: string }) => {
      setMessages(prev => [...prev, { type: 'chat', ...msg }]);
    });

    socketRef.current.on('room_updated', () => {
      fetchRoom(); // 誰かが入退室したら再取得
    });

    socketRef.current.on('game_started', (data: { gameId: number }) => {
      navigate(`/game/${data.gameId}`);
    });

    socketRef.current.on('kicked', ({ userId: kickedId }: { userId: number }) => {
      if (kickedId === user?.id) {
        alert('キックされました');
        navigate('/lobby');
      }
    });


    return () => {
      socketRef.current?.emit('leave_room', { roomId: id, userId: user?.id });
      socketRef.current?.disconnect();
    };
  }, [id]);

  //自動スクロール
  useEffect(() => {
  chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
}, [messages]);

  // ─── 退室 ───
  const leaveRoom = async () => {
    await api.post(`/api/rooms/${id}/leave`);
    navigate('/lobby');
  };

  const sendRoomChat = () => {
  if (!chatInput.trim() || !user) return;
  socketRef.current?.emit('room_chat', {
    roomId: id,
    userId: user.id,
    message: chatInput.trim(),
  });
  setChatInput('');
};

  // ─── ゲーム開始（オーナーのみ）───
  const startGame = async () => {
    setStarting(true);
    setError('');
    try {
      const res = await api.post<{ id: number }>('/api/games/start', { roomId: id });
      // game_started イベントは Socket.io で全員に届くので、
      // ここでは念のため自分だけ遷移
      navigate(`/game/${res.data.id}`);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'ゲーム開始に失敗しました');
      setStarting(false);
    }
  };

  const isOwner = user?.id === room?.owner_id;
  const isLastMember = members.length === 1;
  const canStart = isOwner && members.length >= 1; //開発用　一人でもゲーム開始できるように（メモ）

  if (!room) return <div className="container">読み込み中...</div>;

  return (
  <div className="container">
    {/* ヘッダー */}
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
      borderBottom: '1px solid #4a4a7a', paddingBottom: 8, marginBottom: 16 }}>
      <h1 style={{ fontSize: 18 }}>🚪 {room.name}</h1>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <span style={{ fontSize: 12, color: '#aaa' }}>
          あなた：<span style={{ color: '#7ec8e3' }}>参加者</span>
        </span>
        <button onClick={leaveRoom} style={{ fontSize: 12 }}>
          {isLastMember ? '村を閉じる' : '退室'}
        </button>
      </div>
    </div>

    {error && <p className="error" style={{ marginBottom: 12 }}>{error}</p>}

    <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px', gap: 12 }}>

      {/* 左：チャットエリア */}
      <div>
        {/* メッセージログ */}
        <div style={{ height: 320, overflowY: 'auto', border: '1px solid #2a2a4a',
          padding: 8, marginBottom: 8, fontSize: 13 }}>
          {messages.length === 0 && (
            <p style={{ color: '#555' }}>まだメッセージはありません</p>
          )}
          {messages.map((m, i) => (
            <div key={i} style={{ marginBottom: 4 }}>
              {m.type === 'system' ? (
                <span style={{ color: '#666', fontSize: 11, display: 'block', textAlign: 'center' }}>
                  {m.message}
                </span>
              ) : (
                <>
                  <span style={{ color: '#7ec8e3' }}>{m.handleName}：</span>
                  <span>{m.message}</span>
                </>
              )}
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>

        {/* 入力欄 */}
        <div style={{ display: 'flex', gap: 6 }}>
          <input
            value={chatInput}
            onChange={e => setChatInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && sendRoomChat()}
            placeholder="メッセージを入力..."
            style={{ flex: 1 }}
          />
          <button onClick={sendRoomChat}>送信</button>
        </div>
      </div>

      {/* 右：参加者一覧 + 操作ボタン */}
      <div>
        <h2 style={{ fontSize: 14, color: '#aaa', marginBottom: 8 }}>
          参加者　{members.filter(m => !m.is_spectator).length} / {room.max_players}人
          {members.filter(m => m.is_spectator).length > 0 &&
            `　観戦 ${members.filter(m => m.is_spectator).length}人`}
        </h2>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13, marginBottom: 16 }}>
          <tbody>
            {members.map((m, i) => (
              <tr key={m.id} style={{ borderBottom: '1px solid #2a2a4a' }}>
                <td style={{ padding: '6px 4px', color: '#aaa' }}>{i + 1}</td>
                <td style={{ padding: '6px 4px' }}>
                  {m.handle_name}
                  {m.id === room.owner_id && (
                    <span style={{ color: '#f4c430', fontSize: 11, marginLeft: 4 }}>★オーナー</span>
                  )}
                  {m.is_spectator && (
                    <span style={{ color: '#888', fontSize: 11, marginLeft: 4 }}>👁 観戦</span>
                  )}
                  {m.is_bot && <span style={{ color: '#a78bfa', fontSize: 11, marginLeft: 4 }}>🤖</span>}
                  {m.id === user?.id && (
                    <span style={{ color: '#7ec8e3', fontSize: 11, marginLeft: 4 }}>(あなた)</span>
                  )}
                </td>
                <td style={{ padding: '6px 4px', textAlign: 'right' }}>
                  {isOwner && m.id !== user?.id && (
                    <button
                      onClick={() => api.post(`/api/rooms/${id}/kick`, { targetUserId: m.id })
                        .catch(err => setError(err.message))}
                      style={{ fontSize: 11, color: '#f87171', borderColor: '#7f1d1d', background: 'transparent' }}
                    >
                      キック
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Bot追加 + ゲーム開始 */}
        {isOwner && (
          <button
            onClick={() => api.post(`/api/rooms/${id}/add-bot`)
              .catch(err => setError(err instanceof Error ? err.message : 'Bot追加失敗'))}
            style={{ fontSize: 12, marginBottom: 8, display: 'block', width: '100%' }}
          >
            🤖 Bot を追加
          </button>
        )}
        {isOwner ? (
          <button
            onClick={startGame}
            disabled={!canStart || starting}
            style={{
              width: '100%', padding: '6px 0',
              background: canStart ? '#4a2a7a' : undefined,
              borderColor: canStart ? '#7a4aaa' : undefined,
              fontSize: 13,
            }}
          >
            {starting ? '開始中...' : 'ゲームを開始する'}
          </button>
        ) : (
          <p style={{ color: '#aaa', fontSize: 12 }}>
            オーナーがゲームを開始するのを待っています...
          </p>
        )}
      </div>
    </div>
  </div>
);
}