// Gera o dossie da conversa, grava/atualiza a linha na planilha do Google
// e, quando a pessoa fecha o Plano, dispara o briefing por e-mail para o Marcos.

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
    const briefingJaEnviado = body.briefingEnviado === true;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Sem conversa para resumir." });
    }

    const transcricao = messages.map(function (m) {
      const quem = m.role === "assistant" ? "Clara" : "Cliente";
      return quem + ": " + m.content;
    }).join("\n\n");

    // FECHOU = a Clara chegou a mandar o link de pagamento do Asaas.
    const fechou = messages.some(function (m) {
      return m.role === "assistant" && String(m.content).indexOf("asaas.com/c/") !== -1;
    });

    const instrucaoDossie =
      "Voce recebe a transcricao de uma conversa entre a Maria Clara (IA) e um dono de negocio. " +
      "A conversa pode estar incompleta (em andamento) - tudo bem, resuma o que houver ate aqui. " +
      "Produza um dossie curto e objetivo PARA O MARCOS usar antes da reuniao. " +
      "Responda SOMENTE com um JSON valido, sem texto antes ou depois, com exatamente estas chaves: " +
      "nome (o primeiro nome da pessoa, so o nome, nada mais), " +
      "email (o e-mail que a pessoa informou, se informou), " +
      "whatsapp (o telefone/WhatsApp que a pessoa informou, se informou), " +
      "negocio (o que o negocio faz, em uma frase), " +
      "objetivo (a empreitada especifica que a pessoa esta perseguindo), " +
      "dor (a dor principal, de preferencia com as PALAVRAS da propria pessoa entre aspas), " +
      "sucesso (o que a pessoa definiu como SUCESSO nessa empreitada, com as palavras dela), " +
      "pronto (o sinal concreto de que esta PRONTO/resolvido, com as palavras dela), " +
      "temQue (o que TEM QUE ACONTECER para esse pronto valer), " +
      "naoPode (o que NAO PODE ACONTECER de jeito nenhum), " +
      "fracasso (o que seria FRACASSO, e PARA QUEM), " +
      "proporcao (o tamanho do negocio hoje: faturamento, volume ou porte, para dimensionar o salto), " +
      "qualificacao (leitura de poder de decisao, se tem processo desenhado e prontidao), " +
      "ofertou (responda so 'sim' ou 'nao': a Maria Clara chegou a oferecer o Plano?), " +
      "leitura (a leitura estrategica: por onde o Marcos deve puxar, o gancho mais forte), " +
      "lacunas (liste o que ficou faltando ou raso e o Marcos precisa investigar na primeira reuniao). " +
      "IMPORTANTE: nos campos sucesso, pronto, temQue, naoPode e fracasso, registre APENAS o que a PROPRIA PESSOA " +
      "respondeu. Se quem trouxe aquilo foi a Maria Clara e a pessoa nao confirmou, escreva 'nao respondido pela pessoa'. " +
      "Se algum campo ainda nao tiver informacao, escreva 'nao informado'.";

    const model = "gemini-3.6-flash";
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
      dossie = { leitura: "Bruto: " + texto };
    }

    function campo(v) { return v || ""; }

    const linha = {
      id: id,
      nome: campo(dossie.nome),
      email: campo(dossie.email),
      whatsapp: campo(dossie.whatsapp),
      negocio: campo(dossie.negocio),
      objetivo: campo(dossie.objetivo),
      dor: campo(dossie.dor),
      sucesso: campo(dossie.sucesso),
      pronto: campo(dossie.pronto),
      temQue: campo(dossie.temQue),
      naoPode: campo(dossie.naoPode),
      fracasso: campo(dossie.fracasso),
      proporcao: campo(dossie.proporcao),
      qualificacao: campo(dossie.qualificacao),
      ofertou: campo(dossie.ofertou),
      fechou: fechou ? "SIM" : "",
      leitura: campo(dossie.leitura),
      lacunas: campo(dossie.lacunas),
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

    // Briefing por e-mail: so quando fechou e so uma vez por conversa.
    let briefingEnviado = false;
    if (fechou && !briefingJaEnviado && process.env.RESEND_API_KEY && process.env.EMAIL_DESTINO) {
      try {
        const html = montarEmail(linha);
        const mailRes = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer " + process.env.RESEND_API_KEY
          },
          body: JSON.stringify({
            from: "Maria Clara <clara@send.mariaclara.ai>",
            to: [process.env.EMAIL_DESTINO],
            subject: "FECHOU: " + (linha.nome || "novo cliente") + " - " + (linha.negocio || "Plano"),
            html: html
          })
        });
        briefingEnviado = mailRes.ok;
      } catch (e) {
        briefingEnviado = false;
      }
    }

    if (!sheetOk) {
      return res.status(500).json({ error: "Falha ao gravar na planilha. Status: " + sheetRes.status });
    }

    return res.status(200).json({ ok: true, fechou: fechou, briefingEnviado: briefingEnviado });
  } catch (err) {
    return res.status(500).json({ error: "Falha: " + String(err) });
  }
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function bloco(titulo, valor) {
  return '<p style="margin:0 0 14px 0"><strong style="color:#00674f">' + esc(titulo) +
    '</strong><br>' + esc(valor || "nao informado") + '</p>';
}

function montarEmail(l) {
  const zap = String(l.whatsapp || "").replace(/\D/g, "");
  const linkZap = zap ? '<a href="https://wa.me/' + (zap.length <= 11 ? "55" + zap : zap) + '">' + esc(l.whatsapp) + '</a>' : "nao informado";
  return '' +
  '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:15px;color:#111b21;line-height:1.5;max-width:720px">' +
  '<h2 style="margin:0 0 4px 0">Fechou o Plano: ' + esc(l.nome || "cliente") + '</h2>' +
  '<p style="margin:0 0 20px 0;color:#667781">Briefing gerado pela Maria Clara</p>' +
  '<h3 style="border-bottom:1px solid #e2dcd3;padding-bottom:6px">Contato</h3>' +
  bloco("E-mail", l.email) +
  '<p style="margin:0 0 14px 0"><strong style="color:#00674f">WhatsApp</strong><br>' + linkZap + '</p>' +
  '<h3 style="border-bottom:1px solid #e2dcd3;padding-bottom:6px">O negocio</h3>' +
  bloco("Negocio", l.negocio) +
  bloco("Empreitada (objetivo)", l.objetivo) +
  bloco("Dor principal", l.dor) +
  bloco("Tamanho hoje (proporcao)", l.proporcao) +
  '<h3 style="border-bottom:1px solid #e2dcd3;padding-bottom:6px">As cinco perguntas</h3>' +
  bloco("1. Sucesso", l.sucesso) +
  bloco("2. Pronto", l.pronto) +
  bloco("3. Tem que acontecer", l.temQue) +
  bloco("4. Nao pode acontecer", l.naoPode) +
  bloco("5. Fracasso (e para quem)", l.fracasso) +
  '<h3 style="border-bottom:1px solid #e2dcd3;padding-bottom:6px">Para a reuniao</h3>' +
  bloco("Leitura estrategica", l.leitura) +
  bloco("Qualificacao", l.qualificacao) +
  bloco("Lacunas a investigar", l.lacunas) +
  '<h3 style="border-bottom:1px solid #e2dcd3;padding-bottom:6px">Transcricao integral</h3>' +
  '<pre style="white-space:pre-wrap;font-family:inherit;background:#f7f4f0;padding:14px;border-radius:8px">' +
  esc(l.transcricao) + '</pre>' +
  '</div>';
}
