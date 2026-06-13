import { useState } from 'react';
import { useAuth } from '../hooks/useAuth';

export default function LoginPage() {
  const { login, register } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [handleName, setHandleName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    try {
      if (mode === 'login') {
  await login(handleName, password);
} else {
  await register(handleName, password);
}
window.location.href = '/lobby';  //あとでuseAuthをContextに昇格させて、スムーズに遷移できるようにする（メモ）
    } catch (err: unknown) {
      if (err instanceof Error) {
        setError(err.message);
      } else {
        setError('エラーが発生しました');
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="container" style={{ maxWidth: 400, marginTop: 60 }}>
      <h1 style={{ fontSize: 20, marginBottom: 24, borderBottom: '1px solid #4a4a7a', paddingBottom: 8 }}>
        🐺 人狼ゲーム
      </h1>

      <div style={{ marginBottom: 16 }}>
        <button
          onClick={() => setMode('login')}
          style={{ marginRight: 8, background: mode === 'login' ? '#3a3a6a' : undefined }}
        >ログイン</button>
        <button
          onClick={() => setMode('register')}
          style={{ background: mode === 'register' ? '#3a3a6a' : undefined }}
        >新規登録</button>
      </div>

      <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        <div>
          <label style={{ display: 'block', marginBottom: 4 }}>ハンドルネーム</label>
          <input
            value={handleName}
            onChange={e => setHandleName(e.target.value)}
            placeholder="2〜32文字"
            required
          />
        </div>
        <div>
          <label style={{ display: 'block', marginBottom: 4 }}>パスワード</label>
          <input
            type="password"
            value={password}
            onChange={e => setPassword(e.target.value)}
            placeholder="6文字以上"
            required
          />
        </div>
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={loading} style={{ marginTop: 8 }}>
          {loading ? '処理中...' : mode === 'login' ? 'ログイン' : '登録する'}
        </button>
      </form>
    </div>
  );
}