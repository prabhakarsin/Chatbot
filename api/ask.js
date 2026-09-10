// /api/ask.js
// Deploy as a Vercel serverless function. Uses Google's Gemini API, which has
// a genuine free tier via AI Studio (rate-limited, not a trial that expires).
//
// Required environment variable:
//   GEMINI_API_KEY - get one free at https://aistudio.google.com/apikey
//                     (no credit card required for the free tier)
//
// Free-tier rate limits change and vary by model — check current numbers at
// https://ai.google.dev/gemini-api/docs/pricing before assuming a specific
// requests-per-day figure. gemini-2.5-flash is a solid free-tier choice for
// this use case: fast, supports Google Search grounding, good quality for
// research-style answers.

const MODEL = 'gemini-3.6-flash';

const SYSTEM_PROMPT = `You are Compass, an investment research assistant. Use Google Search grounding to find current, specific information before answering anything about a company, fund, index, or market trend — don't rely on memory for figures, prices, or recent news.

Rules:
- Present objective, sourced analysis: what the data shows, what's being reported, relevant context. Never state a directional prediction ("it will go up/down") or a buy/sell/hold call as if it were a fact.
- Keep exact quotes from sources under 15 words.
- If your answer includes a numeric series worth visualizing (a price trend, a comparison across a few items, historical returns), append ONE fenced block at the very end labeled chartdata containing ONLY valid JSON, nothing else in the block:
\`\`\`chartdata
{"type":"line or bar","title":"short title","labels":["...","..."],"series":[{"name":"series name","values":[1,2,3]}]}
\`\`\`
  Only include this block when you have real numbers from search results — never invent figures.
- End every response that discusses a specific security or fund with one short line reminding the person this is informational, not financial advice.
- Keep responses focused — a few short paragraphs or a tight list, not an essay.`;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  try {
    const { history } = req.body; // [{role:'user'|'assistant', content: '...'}, ...]

    // Gemini uses 'user' and 'model' roles, not 'assistant'
    const contents = history.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }],
    }));

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`;

    const geminiRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
        contents,
        tools: [{ google_search: {} }],
      }),
    });

    const data = await geminiRes.json();

    if (data.error) {
      return res.status(502).json({ error: data.error.message || 'Gemini API error' });
    }

    const parts = data.candidates?.[0]?.content?.parts || [];
    const text = parts.map(p => p.text || '').join('\n');

    // Grounding metadata includes the actual search sources used, if you want
    // to surface them later — see data.candidates[0].groundingMetadata
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ text });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
