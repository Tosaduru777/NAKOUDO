const MAX_PER_DAY = 2;
const MODEL = 'claude-haiku-4-5-20251001';
const MAX_TOKENS = 300;

async function kvGet(key) {
  const res = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/get/${key}`, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
  });
  const data = await res.json();
  return data.result;
}

async function kvIncr(key) {
  const res = await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/incr/${key}`, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
  });
  const data = await res.json();
  return data.result;
}

async function kvExpireAt(key, unixSec) {
  await fetch(`${process.env.UPSTASH_REDIS_REST_URL}/expireat/${key}/${unixSec}`, {
    headers: { Authorization: `Bearer ${process.env.UPSTASH_REDIS_REST_TOKEN}` },
  });
}

function getTodayKey(ip) {
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return `nakoudo:${ip}:${today}`;
}

function getMidnightUnix() {
  const now = new Date();
  const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.floor(midnight.getTime() / 1000);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // IP取得（英数字・ドット・コロンのみ許可してサニタイズ）
  const rawIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim();
  const ip = /^[a-fA-F0-9.:]+$/.test(rawIp) ? rawIp : 'unknown';
  const key = getTodayKey(ip);

  try {
    // レート制限チェック
    const count = parseInt(await kvGet(key) || '0', 10);
    if (count >= MAX_PER_DAY) {
      return res.status(429).json({ error: 'rate_limit', message: '本日のご縁は結び終えました。また明日どうぞ。' });
    }

    // Anthropic APIに送信（model/system/max_tokensはサーバー側で固定）
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const payload = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: body.system,
      messages: body.messages,
    };
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = await response.json();
    if (!response.ok) {
      return res.status(response.status).json(data);
    }

    // 成功時のみカウントアップ（ゲーム開始の最初のメッセージのみカウント）
    if(body.messages && body.messages.length === 1) {
      const newCount = await kvIncr(key);
      if (newCount === 1) {
        await kvExpireAt(key, getMidnightUnix());
      }
    }
    return res.status(200).json(data);

  } catch (error) {
    console.error('API Error:', error);
    return res.status(500).json({ error: 'Internal server error' });
  }
}
