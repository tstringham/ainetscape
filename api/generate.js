// /api/generate.js
//
// Serverless proxy. Keeps the Anthropic API key on the server so
// AINetscape.com visitors can't lift it from view-source and burn
// through Thomas's account. Pinned to the model we tested with.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server misconfiguration: missing ANTHROPIC_API_KEY' });
  }

  const { system, brief } = req.body || {};
  if (!brief || typeof brief !== 'string') {
    return res.status(400).json({ error: 'Missing brief' });
  }

  // Light rate-limit guard: cap brief length so randos can't pipe novels in.
  if (brief.length > 4000) {
    return res.status(400).json({ error: 'Brief too long (max 4000 chars)' });
  }

  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5-20250929',
        max_tokens: 8000,
        system: system || '',
        messages: [{ role: 'user', content: 'Brief:\n\n' + brief }]
      })
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: data?.error?.message || 'Upstream API error'
      });
    }

    // Pass through the same shape the client already knows how to parse.
    return res.status(200).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
