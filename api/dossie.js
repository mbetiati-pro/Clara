// Gera o dossiê da conversa e grava/atualiza a linha na planilha do Google.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Método não permitido" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const sheetsUrl = process.env.SHEETS_URL;
  if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY não configurada." });
  if (!sheetsUrl) return res.status(500).json({ error: "SHEETS_URL não configurada." });

  try {
    const { messages, id, nome } = req.body || {};
    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Sem conversa para resumir." });
    }

    const transcricao = messages.map(function (m) {
      var quem = m.role === "assistant" ? "Clara" : "Cliente";
      return quem + ": " + m.content;
    }).join("\n\n");

    const instrucaoDossie =
      "Você recebe a transcrição de uma conversa entre a Clara (IA) e um dono de negócio. " +
      "A conversa pode estar incompleta (em andamento) - tudo bem, resuma o que houver até aqui. " +
      "Produza um dossiê curto e objetivo PARA O MARCOS usar antes da reunião. " +
      "Responda SOMENTE com um JSON válido, sem texto antes ou depois, com exatamente estas chaves: " +
      "negocio (o que o negócio faz, em uma frase), " +
      "dor (a dor principal, de preferência com as PALAVRAS da própria pessoa entre aspas), " +
      "qualificacao (leitura de orçamento, poder de decisão e prontidão, em uma ou duas frases), " +
      "ofertou (responda só 'sim' ou 'não': a Clara chegou a oferecer o Plano de R$ 3.907?), " +
      "leitura (a leitura estratégica: por onde o Marcos deve puxar na reunião, o gancho mais forte). " +
      "Se algum campo ainda não tiver informação, escreva 'não informado'.";

    const model = "gemini-2.5-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;

    const geminiRes = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: instrucaoDossie }] },
        contents: [{ role: "user", parts: [{ text: transcricao }] }],
        generationConfig: { responseMimeType: "application/json" }
      })
    });

    const data = await geminiRes.json();
    if (!geminiRes.ok) {
      return res.status(500).json({ error: "Gemini: " + JSON.stringify(data) });
    }

    let texto = data?.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    texto = texto.replace(/```json/g, "").replace(/```/g, "").trim();

    let dossie;
    try {
      dossie = JSON.parse(texto);
    } catch (e) {
      dossie = { negocio: "", dor: "", qualificacao: "", ofertou: "", leitura: "Não estruturou. Bruto: " + texto };
    }

    const linha = {
      id: id || "",
      nome: nome || "",
      negocio: dossie.negocio || "",
      dor: dossie.dor || "",
      qualificacao: dossie.qualificacao || "",
      ofertou: dossie.ofertou || "",
      leitura: dossie.leitura || "",
      transcricao: transcricao
    };

    const sheetRes = await fetch(sheetsUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(linha)
    });

    let sheetOk = false;
    try {
      const sheetData = await sheetRes.json();
      sheetOk = sheetData && sheetData.ok;
    } catch (e) {
      sheetOk = sheetRes.ok;
    }

    if (!sheetOk) {
      return res.status(500).json({ error: "Falha ao gravar na planilha. Status: " + sheetRes.status });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    return res.status(500).json({ error: "Falha: " + String(err) });
  }
}
