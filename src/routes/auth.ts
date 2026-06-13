//src/routes/auth.ts



import { Router, Request, Response } from 'express';
import bcrypt from 'bcrypt';
import { query } from '../db';

export const authRouter = Router();

// セッションにユーザー情報を持たせるための型拡張
declare module 'express-session' {
  interface SessionData {
    userId: number;
    handleName: string;
  }
}

// ─── 登録 POST /api/auth/register ───
authRouter.post('/register', async (req: Request, res: Response) => {
  const { handleName, password } = req.body;

  // バリデーション
  if (!handleName || !password) {
    res.status(400).json({ error: 'ハンドルネームとパスワードは必須です' });
    return;
  }
  if (handleName.length < 2 || handleName.length > 32) {
    res.status(400).json({ error: 'ハンドルネームは2〜32文字です' });
    return;
  }
  if (password.length < 6) {
    res.status(400).json({ error: 'パスワードは6文字以上です' });
    return;
  }

  try {
    // HN重複チェック
    const existing = await query(
      'SELECT id FROM users WHERE handle_name = $1',
      [handleName]
    );
    if (existing.rows.length > 0) {
      res.status(409).json({ error: 'このハンドルネームはすでに使われています' });
      return;
    }

    // パスワードをハッシュ化して保存
    const passwordHash = await bcrypt.hash(password, 10);
    const result = await query(
      `INSERT INTO users (handle_name, password_hash)
       VALUES ($1, $2)
       RETURNING id, handle_name, currency_balance, rating, created_at`,
      [handleName, passwordHash]
    );

    const user = result.rows[0];

    // 登録と同時にログイン状態にする
    req.session.userId = user.id;
    req.session.handleName = user.handle_name;

    res.status(201).json({
      id: user.id,
      handleName: user.handle_name,
      currencyBalance: user.currency_balance,
      rating: user.rating,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ─── ログイン POST /api/auth/login ───
authRouter.post('/login', async (req: Request, res: Response) => {
  const { handleName, password } = req.body;

  if (!handleName || !password) {
    res.status(400).json({ error: 'ハンドルネームとパスワードは必須です' });
    return;
  }

  try {
    const result = await query(
      'SELECT * FROM users WHERE handle_name = $1',
      [handleName]
    );

    if (result.rows.length === 0) {
      res.status(401).json({ error: 'ハンドルネームまたはパスワードが違います' });
      return;
    }

    const user = result.rows[0];
    const match = await bcrypt.compare(password, user.password_hash);

    if (!match) {
      res.status(401).json({ error: 'ハンドルネームまたはパスワードが違います' });
      return;
    }

    req.session.userId = user.id;
    req.session.handleName = user.handle_name;

    res.json({
      id: user.id,
      handleName: user.handle_name,
      currencyBalance: user.currency_balance,
      rating: user.rating,
    });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ─── ログアウト POST /api/auth/logout ───
authRouter.post('/logout', (req: Request, res: Response) => {
  req.session.destroy(() => {
    res.json({ message: 'ログアウトしました' });
  });
});

// ─── ログイン状態確認 GET /api/auth/me ───
authRouter.get('/me', (req: Request, res: Response) => {
  if (!req.session.userId) {
    res.status(401).json({ error: '未ログイン' });
    return;
  }
  res.json({
    id: req.session.userId,
    handleName: req.session.handleName,
  });
});