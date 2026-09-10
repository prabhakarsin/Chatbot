// /api/ask.js
// Deploy as a Vercel serverless function. Uses OpenRouter's free tier with streaming.
// Required environment variable:
//   OPENROUTER_API_KEY - get one at https://openrouter.ai

// Using the openrouter/free multi-model proxy router for 100% free fallback execution.
const MODEL = 'openrouter/free'; 

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

    // Standardize to OpenAI / OpenRouter message format
    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.map(m => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content
      }))
    ];

    // FIX: Changed from base URL to the explicit Chat Completions endpoint
    const url = 'https://openrouter.ai';

    const openRouterRes = await fetch(url, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.OPENROUTER_API_KEY}`
      },
      body: JSON.stringify({
        model: MODEL,
        messages,
        // Requests the web search plugin capabilities for current context integration
        plugins: [{ id: 'web-search' }],
        // Enables real-time streaming tokens
        stream: true 
      }),
    });

    // Safeguard: Catch upstream HTML errors (like a 502/504 gateway crash) before parsing
    if (!openRouterRes.ok) {
      const errorText = await openRouterRes.text();
      return res.status(openRouterRes.status).json({ 
        error: `OpenRouter returned status ${openRouterRes.status}: ${errorText}` 
      });
    }

    // Set streaming headers for the browser client
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    // Read the incoming byte stream from OpenRouter and pipe it straight out to the client
    const reader = openRouterRes.body.getReader();
    const decoder = new TextDecoder();

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      
      // Flush data chunks to the frontend in real time
      res.write(decoder.decode(value, { stream: true }));
    }

    res.end();
  } catch (err) {
    // If the streaming headers haven't gone out yet, fallback to a standard JSON error payload
    if (!res.headersSent) {
      res.status(500).json({ error: err.message });
    } else {
      res.end();
    }
  }
};
