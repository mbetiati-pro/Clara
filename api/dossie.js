// Gera o dossiê da conversa e grava/atualiza a linha na planilha do Google.

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metodo nao permitido" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const sheetsUrl = process.env.SHEETS_URL;
  if (!apiKey) return res.status(500).json({ error: "GEMINI_API_KEY nao configurada." });
  if (!sheetsUrl) return res.status(500).json({ error: "SHEETS_URL nao configurada." });

  try {
    const body = req.body || {};
    const messages = body.messages;
    const id = body.id || "";

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Sem conversa para resumir." });
    }

    const transcricao = messages.map(function (m) {
      const quem = m.role === "assistant" ? "Clara" : "Cliente";
      return quem + ": " + m.content;
    }).join("\n\n");

    const instrucaoDossie =
      "Voce recebe a transcricao de uma conversa entre a Maria Clara (IA) e um dono de negocio. " +
      "A conversa pode estar incompleta (em andamento) - tudo bem, resuma o que houver ate aqui. " +
      "Produza um dossie curto e objetivo PARA O MARCOS usar antes da reuniao. " +
      "Responda SOMENTE com um JSON valido, sem texto antes ou depois, com exatamente estas chaves: " +
      "nome (o primeiro nome da pessoa, so o nome, nada mais), " +
      "negocio (o que o negocio faz, em uma frase), " +
      "dor (a dor principal, de preferencia com as PALAVRAS da propria pessoa entre aspas), " +
      "qualificacao (leitura de faturamento/receita, poder de decisao, se tem processo desenhado e prontidao), " +
      "ofertou (responda so 'sim' ou 'nao': a Maria Clara chegou a oferecer o Plano de R$ 3.907?), " +
      "leitura (a leitura estrategica: por onde o Marcos deve puxar, o gancho mais forte). " +
      "Se algum campo ainda nao tiver informacao, escreva 'nao informado'.";

    const model = "gemini-2.5-flash-lite";
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";

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

    let texto = "{}";
    if (data && data.candidates && data.candidates[0] && data.candidates[0].content
        && data.candidates[0].content.parts && data.candidates[0].content.parts[0]) {
      texto = data.candidates[0].content.parts[0].text || "{}";
    }
    texto = texto.replace(/```json/g, "").replace(/```/g, "").trim();

    let dossie;
    try {
      dossie = JSON.parse(texto);
    } catch (e) {
      dossie = { nome: "", negocio: "", dor: "", qualificacao: "", ofertou: "", leitura: "Bruto: " + texto };
    }

    const linha = {
      id: id,
      nome: dossie.nome || "",
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
