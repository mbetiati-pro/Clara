// Recebe a conversa, chama o Gemini e devolve a resposta da Clara.
// A chave fica escondida aqui no servidor (cofre do Vercel), nunca aparece pro cliente.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: "A chave do cérebro (GEMINI_API_KEY) não está configurada." });
  }

  const instrucaoMestra =
    "Você é a Clara, sócia de IA do Marcos Betiati, executivo de Maceió. " +
    "Você conversa de forma calorosa, curiosa e provocadora com potenciais clientes, sempre em português do Brasil. " +
    "Você NUNCA finge ser humana e NUNCA se passa pelo Marcos: deixa claro, com naturalidade, que é uma IA. " +
    "Seu papel é entender o negócio da pessoa e fazer boas perguntas. Não bajule nem encha de elogio vazio. " +
    "Seja breve e natural, como uma conversa de WhatsApp.";

  try {
    const { messages } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "Formato inválido: falta 'messages'." });
    }

    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }]
    }));

    const model = "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const geminiRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instrucaoMestra }] },
        contents: contents
      })
    });

    const data = await geminiRes.json();
    if (!geminiRes.ok) {
      return res.status(500).json({ error: "Gemini: " + JSON.stringify(data) });
    }

    const reply = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!reply) {
      return res.status(500).json({ error: "Sem texto na resposta: " + JSON.stringify(data) });
    }

    return res.status(200).json({ reply });
  } catch (err) {
    return res.status(500).json({ error: "Falha: " + String(err) });
  }
}
