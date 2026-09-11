// /api/ask.js
// Deploy as a Vercel serverless function.

const NVIDIA_MODELS = [
  // 🟢 CURRENT & ACTIVE: Flagship custom NVIDIA model path
  'nvidia/llama-3.1-nemotron-70b-instruct',
  
  // 🟢 CURRENT & ACTIVE: Meta's direct drop-in replacement path
  'meta/llama-3.3-70b-instruct'
];

const SYSTEM_PROMPT = `You are Compass, an investment research assistant. You will be given web search results alongside the user's question — use them to answer with current, specific information. Don't rely on memory for figures, prices, or recent news; if the search results don't cover something, say so rather than guessing.

Rules:
- Present objective, sourced analysis: what the data shows, what's being reported, relevant context. Never state a directional prediction ("it will go up/down") or a buy/sell/hold call as if it were a fact.
- When you use something from the search results, name the source plainly in your prose (e.g. "according to Reuters..."), and keep exact quotes under 15 words.
- If your answer includes a numeric series worth visualizing (a price trend, a comparison across a few items, historical returns), append ONE fenced block at the very end labeled chartdata containing ONLY valid JSON, nothing else in the block:
\`\`\`chartdata
{"type":"line or bar","title":"short title","labels":["...","..."],"series":[{"name":"series name","values":}]}
\`\`\`
  Only include this block when you have real numbers from the search results — never invent figures.
- End every response that discusses a specific security or fund with one short line reminding the person this is informational, not financial advice.
- Keep responses focused — a few short paragraphs or a tight list, not an essay.`;

async function tavilySearch(query) {
  if (!process.env.TAVILY_API_KEY) return [];
  try {
    const res = await fetch('https://tavily.com', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        search_depth: 'basic',
        max_results: 6,
        include_answer: false,
      }),
    });
    const bodyText = await res.text();
    if (!bodyText) return [];
    const data = JSON.parse(bodyText);
    return data.results || [];
  } catch (err) {
    return [];
  }
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }

  try {
    const { history } = req.body;
    if (!Array.isArray(history) || history.length === 0) {
      return res.status(400).json({ error: 'history is required' });
    }

    const lastUserMsg = [...history].reverse().find(m => m.role === 'user');
    if (!lastUserMsg) {
      return res.status(400).json({ error: 'No user message found in history' });
    }

    const results = await tavilySearch(lastUserMsg.content);
    const sourcesBlock = results.length
      ? 'Web search results:\n\n' + results.map((r, i) =>
          `[${i + 1}] ${r.title}\n${r.url}\n${(r.content || '').slice(0, 500)}`
        ).join('\n\n')
      : 'No web search results were found for this query.';

    const messages = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...history.map(m => {
        if (m === lastUserMsg) {
          return { role: 'user', content: `${m.content}\n\n---\n${sourcesBlock}` };
        }
        return { role: m.role, content: m.content };
      }),
    ];

    let finalResponseText = '';
    let lastError = null;

    for (const model of NVIDIA_MODELS) {
      const nvidiaRes = await fetch('https://nvidia.com', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.NVIDIA_API_KEY}`,
        },
        body: JSON.stringify({
          model,
          messages,
          temperature: 0.4,
          max_tokens: 1024,
          stream: true // 🔥 FIX 1: Enforce streaming to prevent empty choice responses from NVIDIA NIM
        }),
      });

      if (!nvidiaRes.ok) {
        const errText = await nvidiaRes.text();
        lastError = `NVIDIA API (${model}) returned ${nvidiaRes.status}: ${errText.slice(0, 200)}`;
        continue;
      }

      // 🔥 FIX 2: Safely parse Server-Sent Events (SSE) data stream chunks
      const reader = nvidiaRes.body.setEncoding('utf-8');
      let accumulatedText = '';
      
      for await (const chunk of nvidiaRes.body) {
        const lines = chunk.split('\n');
        for (const line of lines) {
          const cleanLine = line.trim();
          if (!cleanLine || !cleanLine.startsWith('data:')) continue;
          
          const dataStr = cleanLine.replace(/^data:\s*/, '');
          if (dataStr === '[DONE]') break;
          
          try {
            const parsed = JSON.parse(dataStr);
            const delta = parsed.choices?.[0]?.delta;
            const content = delta?.content || delta?.reasoning_content || '';
            accumulatedText += content;
          } catch (e) {
            // Drop unparseable heartbeat keep-alive frames safely
          }
        }
      }

      finalResponseText = accumulatedText
        .replace(/<think>[\s\S]*?<\/think>/gi, '')
        .trim();

      if (finalResponseText) break; // Success, stop falling through the models array
      lastError = `Model ${model} streamed an empty text block.`;
    }

    if (!finalResponseText) {
      return res.status(502).json({
        error: lastError || 'All models failed to generate content.',
      });
    }

    res.setHeader('Cache-Control', 'no-store');
    res.status(200).json({ text: finalResponseText });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
