//src/db.ts


import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }, // Supabase接続に必要
});

// 接続テスト用のヘルパー
export const query = (text: string, params?: unknown[]) => {
  return pool.query(text, params);
};