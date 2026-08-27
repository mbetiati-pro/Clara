// Gera o dossie da conversa, grava/atualiza a linha na planilha do Google,
// agenda a analise de clareza para a pessoa (Resend) e, quando ela fecha o Plano,
// dispara o briefing por e-mail para o Marcos.

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
    const origem = String(body.origem || "direto").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 24) || "direto";
    const briefingJaEnviado = body.briefingEnviado === true;
    const analiseJaAgendada = body.analiseAgendada === true;
    const encerrando = body.encerrando === true;

    if (!Array.isArray(messages) || messages.length === 0) {
      return res.status(400).json({ error: "Sem conversa para resumir." });
    }

    const transcricao = messages.map(function (m) {
      const quem = m.role === "assistant" ? "Clara" : "Cliente";
      return quem + ": " + m.content;
    }).join("\n\n");

    // FECHOU = a Clara chegou a mandar o link de pagamento do Asaas.
    const fechou = messages.some(function (m) {
      // Cobre os dois formatos: o link antigo (/c/) e o checkout novo
      // (/checkoutSession/), inclusive o dominio de sandbox.
      return m.role === "assistant" && /asaas\.com\/(c\/|checkoutSession)/.test(String(m.content));
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
      "prioridade (SO o numero de 1 a 5, sem texto: o quanto vale o Marcos gastar tempo com esta pessoa. " +
      "5 = decide sozinha, dor clara, urgencia real e porte que comporta o investimento. " +
      "1 = nao decide, sem dor definida, ou porte incompativel. Seja severo: 5 e raro e a maioria fica em 2 ou 3), " +
      "leitura (a leitura estrategica: por onde o Marcos deve puxar, o gancho mais forte), " +
      "lacunas (liste o que ficou faltando ou raso e o Marcos precisa investigar na primeira reuniao). " +
      "IMPORTANTE: nos campos sucesso, pronto, temQue, naoPode e fracasso, registre APENAS o que a PROPRIA PESSOA " +
      "respondeu. Se quem trouxe aquilo foi a Maria Clara e a pessoa nao confirmou, escreva 'nao respondido pela pessoa'. " +
      "Se algum campo ainda nao tiver informacao, escreva 'nao informado'.";

    const model = "gemini-3.6-flash";
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + model + ":generateContent";

    const corpo = JSON.stringify({
      systemInstruction: { parts: [{ text: instrucaoDossie }] },
      contents: [{ role: "user", parts: [{ text: transcricao }] }],
      generationConfig: { responseMimeType: "application/json" }
    });

    const r = await chamarComRetentativa(url, corpo, apiKey);
    if (!r.ok) {
      console.log("DOSSIE FALHA status=" + r.status + " tentativas=" + r.tentativas
        + " detalhe=" + JSON.stringify(r.data).slice(0, 500));
      return res.status(200).json({ ok: false, motivo: "gemini indisponivel" });
    }

    registrarUso("dossie", messages.length, r.tentativas, r.data);
    const dossie = extrairJson(r.data);

    function campo(v) { return v || ""; }

    const linha = {
      id: id,
      origem: origem,
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
      prioridade: campo(dossie.prioridade),
      fechou: fechou ? "SIM" : "",
      analise: "",
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
            "Authorization": "Bearer " + process.env.RESEND_API_KEY,
            "Idempotency-Key": "briefing-" + id
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

    // -----------------------------------------------------------------------
    // Analise de clareza para a PESSOA.
    // Roda DEPOIS de gravar a planilha, e de proposito: a linha e o ativo
    // principal e nao pode depender de uma segunda chamada ao Gemini nem do
    // Resend. Se qualquer coisa aqui falhar ou demorar, o lead ja esta salvo.
    // So dispara quando a conversa acabou de verdade (aba fechada, inatividade
    // longa ou venda fechada), so uma vez, e so com e-mail valido.
    // -----------------------------------------------------------------------
    let analiseAgendadaAgora = false;
    const emailPessoa = limparEmail(campo(dossie.email));
    const podeAgendar = (encerrando || fechou)
      && !analiseJaAgendada
      && emailPessoa
      && messages.length >= 8
      && process.env.RESEND_API_KEY;

    if (podeAgendar) {
      try {
        const analise = await gerarAnalise(transcricao, fechou, url, apiKey, messages.length);
        if (analise) {
          const quando = calcularAgendamento(origem);
          const enviado = await agendarAnalise(analise, emailPessoa, quando, id);
          if (enviado) {
            analiseAgendadaAgora = true;
            console.log("ANALISE AGENDADA id=" + id + " origem=" + origem + " para=" + quando);

            // Segunda gravacao, so pra registrar o horario na coluna Analise.
            // Se falhar, paciencia: o lead ja esta na planilha e o e-mail ja
            // esta agendado no Resend.
            try {
              linha.analise = formatarBR(quando);
              await fetch(sheetsUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(linha)
              });
            } catch (e) {
              console.log("ANALISE sem registro na planilha id=" + id);
            }
          }
        }
      } catch (e) {
        console.log("ANALISE FALHA id=" + id + " erro=" + String(e).slice(0, 300));
      }
    }

    if (!sheetOk) {
      return res.status(500).json({ error: "Falha ao gravar na planilha. Status: " + sheetRes.status });
    }

    return res.status(200).json({
      ok: true,
      fechou: fechou,
      briefingEnviado: briefingEnviado,
      analiseAgendada: analiseAgendadaAgora
    });
  } catch (err) {
    return res.status(500).json({ error: "Falha: " + String(err) });
  }
}


// ---------------------------------------------------------------------------
// A analise de clareza que vai para a PESSOA.
// ---------------------------------------------------------------------------

async function gerarAnalise(transcricao, fechou, url, apiKey, qtdMensagens) {
  const fecho = fechou
    ? "A pessoa JA FECHOU o Plano com o Marcos. No campo 'proximo', de as boas-vindas com sobriedade e diga que o Marcos entra em contato pelo WhatsApp para agendar as duas reunioes. NAO venda nada de novo e NAO repita preco."
    : "A pessoa NAO fechou o Plano. No campo 'proximo', feche reconhecendo o que ela ja construiu na conversa e deixe UMA porta aberta, curta e sem pressao: se ela quiser destravar isso com o Marcos, e so responder este e-mail. Uma frase, no maximo duas. NAO repita preco, NAO reapresente o formato do Plano e NAO insista.";

  const instrucao =
    "Voce e a Maria Clara, uma IA e sócia do Marcos Betiati. Voce acabou de conversar com um dono de negocio " +
    "e prometeu mandar por escrito uma analise de clareza do negocio dele, com um angulo que nao coube na conversa. " +
    "Escreva essa analise agora, falando DIRETAMENTE com a pessoa, em portugues do Brasil, na segunda pessoa (voce). " +
    "Responda SOMENTE com um JSON valido, sem texto antes ou depois, com exatamente estas chaves: " +
    "assunto (a linha de assunto do e-mail: curta, concreta e especifica do negocio DELA - nunca algo generico como 'sua analise' ou 'nossa conversa'), " +
    "nome (SO o primeiro nome da pessoa, sem sobrenome, sem saudacao e sem pontuacao), " +
    "retrato (2 a 4 paragrafos devolvendo com clareza a empreitada dela, o que ela definiu como sucesso e o sinal de pronto, usando as PALAVRAS dela sempre que possivel), " +
    "insight (OBRIGATORIO e a parte mais importante: um angulo NOVO, que NAO foi dito na conversa. " +
    "Uma leitura, um risco silencioso ou uma oportunidade que a conversa nao alcancou. De 1 a 3 paragrafos. " +
    "Isto foi prometido a ela, entao tem que ser conteudo de verdade e nao um resumo requentado do que ja foi falado), " +
    "proximo (o paragrafo de fechamento). " +
    fecho + " " +
    "ACENTUACAO (regra critica): esta instrucao que voce esta lendo foi escrita SEM acentos por uma limitacao tecnica do arquivo. " +
    "NAO copie esse estilo. O e-mail que voce escrever tem que sair em portugues do Brasil com ortografia e ACENTUACAO COMPLETAS E CORRETAS " +
    "em todas as chaves do JSON, inclusive no assunto: voce, analise, operacao, atencao, sao, ja, tambem, alem, e assim por diante. " +
    "Texto sem acento passa desleixo e derruba a confianca antes da pessoa chegar no conteudo. " +
    "REGRAS DURAS: nada de bajulacao nem elogio inflado - reconhecimento so ancorado em algo concreto que ela disse. " +
    "Use SEMPRE o vocabulario do mundo dela e NUNCA importe jargao de outro ramo; jamais fale de paciente ou consultorio com quem nao e da saude. " +
    "Nao use travessao longo, use hifen. Nao use asterisco, negrito, marcador nem numeracao. " +
    "Nao invente numero, prazo, dado ou fato que a pessoa nao tenha dito. " +
    "Se a conversa foi curta e voce tem pouca coisa, escreva menos: texto inflado para parecer entrega e pior que texto curto e honesto.";

  const corpo = JSON.stringify({
    systemInstruction: { parts: [{ text: instrucao }] },
    contents: [{ role: "user", parts: [{ text: transcricao }] }],
    generationConfig: { responseMimeType: "application/json" }
  });

  const r = await chamarComRetentativa(url, corpo, apiKey);
  if (!r.ok) {
    console.log("ANALISE GEMINI FALHA status=" + r.status + " tentativas=" + r.tentativas);
    return null;
  }
  registrarUso("analise", qtdMensagens, r.tentativas, r.data);

  const a = extrairJson(r.data);
  if (!a || !a.insight || !a.retrato) return null;
  if (!a.nome) a.nome = "";
  return a;
}

// Origem de evento recebe a analise a noite, quando a pessoa esta em condicao de ler.
// Origem direta recebe em 1 hora, com a conversa ainda quente.
function calcularAgendamento(origem) {
  const EVENTO = { palco: 1, totem: 1, nfc: 1 };
  const agora = Date.now();

  if (!EVENTO[origem]) {
    return new Date(agora + 3600000).toISOString();
  }

  const OFFSET = 3 * 3600000; // Brasilia = UTC-3
  const br = new Date(agora - OFFSET); // os campos UTC deste objeto sao a hora de Brasilia
  let alvo;
  if (br.getUTCHours() < 19) {
    alvo = Date.UTC(br.getUTCFullYear(), br.getUTCMonth(), br.getUTCDate(), 20, 30, 0) + OFFSET;
  } else {
    alvo = Date.UTC(br.getUTCFullYear(), br.getUTCMonth(), br.getUTCDate() + 1, 9, 0, 0) + OFFSET;
  }
  if (alvo - agora < 600000) alvo = agora + 600000; // nunca menos de 10 minutos
  return new Date(alvo).toISOString();
}

async function agendarAnalise(a, para, quando, id) {
  const pacote = {
    from: "Maria Clara <clara@send.mariaclara.ai>",
    to: [para],
    subject: String(a.assunto || "Sobre o que a gente conversou").slice(0, 120),
    scheduled_at: quando,
    html: montarEmailAnalise(a)
  };
  if (process.env.EMAIL_DESTINO) {
    pacote.bcc = [process.env.EMAIL_DESTINO];
    pacote.reply_to = process.env.EMAIL_DESTINO;
  }

  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": "Bearer " + process.env.RESEND_API_KEY,
      "Idempotency-Key": "analise-" + id
    },
    body: JSON.stringify(pacote)
  });

  if (!r.ok) {
    let detalhe = "";
    try { detalhe = JSON.stringify(await r.json()).slice(0, 300); } catch (e) {}
    console.log("RESEND ANALISE FALHA status=" + r.status + " " + detalhe);
    return false;
  }
  return true;
}

function paragrafos(texto) {
  return String(texto == null ? "" : texto)
    .split(/\n+/)
    .map(function (t) { return t.trim(); })
    .filter(function (t) { return t.length > 0; })
    .map(function (t) { return '<p style="margin:0 0 16px 0">' + esc(t) + "</p>"; })
    .join("");
}

function montarEmailAnalise(a) {
  const primeiro = String(a.nome || "").trim().split(/\s+/)[0] || "";
  const abertura = primeiro
    ? "Ol\u00e1, " + esc(primeiro) + "!<br>Tudo bom?"
    : "Ol\u00e1!<br>Tudo bom?";

  return "" +
  '<div style="font-family:-apple-system,Segoe UI,Roboto,sans-serif;font-size:16px;color:#111b21;line-height:1.6;max-width:600px;margin:0 auto;padding:8px">' +
  '<p style="margin:0 0 16px 0">' + abertura + "</p>" +
  paragrafos(a.retrato) +
  '<div style="border-left:3px solid #00674f;padding-left:16px;margin:0 0 16px 0">' +
  paragrafos(a.insight) +
  "</div>" +
  paragrafos(a.proximo) +
  '<p style="margin:0 0 16px 0">Muito obrigada!</p>' +
  '<p style="margin:0 0 16px 0">Abra\u00e7os,<br>Maria Clara<br>' +
  '<a href="https://mariaclara.ai" style="color:#00674f">mariaclara.ai</a></p>' +
  '<p style="margin:24px 0 0 0;color:#667781;font-size:13px;line-height:1.5;border-top:1px solid #e2dcd3;padding-top:14px">' +
  "Maria Clara, sou uma IA e s\u00f3cia do Marcos Betiati.<br>" +
  "Escrevi esta an\u00e1lise a partir da conversa que tivemos em mariaclara.ai.</p>" +
  "</div>";
}


// ---------------------------------------------------------------------------
// Briefing interno para o Marcos.
// ---------------------------------------------------------------------------

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
  bloco("Prioridade (1 a 5)", l.prioridade) +
  bloco("Lacunas a investigar", l.lacunas) +
  '<h3 style="border-bottom:1px solid #e2dcd3;padding-bottom:6px">Transcricao integral</h3>' +
  '<pre style="white-space:pre-wrap;font-family:inherit;background:#f7f4f0;padding:14px;border-radius:8px">' +
  esc(l.transcricao) + '</pre>' +
  '</div>';
}


// ---------------------------------------------------------------------------
// Infra: retentativa com espera progressiva e registro de consumo de token.
// ---------------------------------------------------------------------------

function limparEmail(valor) {
  const t = String(valor || "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@.]+\.[^\s@]{2,}$/.test(t)) return "";
  return t;
}

function formatarBR(iso) {
  const d = new Date(new Date(iso).getTime() - 3 * 3600000);
  function dd(n) { return (n < 10 ? "0" : "") + n; }
  return dd(d.getUTCDate()) + "/" + dd(d.getUTCMonth() + 1) + "/" + d.getUTCFullYear()
    + " " + dd(d.getUTCHours()) + ":" + dd(d.getUTCMinutes());
}

function extrairJson(data) {
  let texto = "{}";
  if (data && data.candidates && data.candidates[0] && data.candidates[0].content
      && data.candidates[0].content.parts && data.candidates[0].content.parts[0]) {
    texto = data.candidates[0].content.parts[0].text || "{}";
  }
  texto = texto.replace(/```json/g, "").replace(/```/g, "").trim();
  try {
    return JSON.parse(texto);
  } catch (e) {
    return { leitura: "Bruto: " + texto };
  }
}

function pausa(ms) {
  const jitter = Math.floor(Math.random() * 400);
  return new Promise(function (r) { setTimeout(r, ms + jitter); });
}

async function chamarComRetentativa(url, corpo, apiKey) {
  const esperas = [900, 2200, 4800];
  let ultimo = { ok: false, status: 0, data: {}, tentativas: 0 };

  for (let i = 0; i <= esperas.length; i++) {
    let resposta = null;
    let dados = {};
    try {
      resposta = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
        body: corpo
      });
      dados = await resposta.json();
    } catch (e) {
      ultimo = { ok: false, status: 0, data: { erro: String(e) }, tentativas: i + 1 };
      if (i < esperas.length) { await pausa(esperas[i]); continue; }
      return ultimo;
    }

    if (resposta.ok) {
      return { ok: true, status: 200, data: dados, tentativas: i + 1 };
    }

    ultimo = { ok: false, status: resposta.status, data: dados, tentativas: i + 1 };

    const valeRetentar = resposta.status === 429 || resposta.status === 500
      || resposta.status === 502 || resposta.status === 503 || resposta.status === 504;
    if (!valeRetentar || i === esperas.length) return ultimo;

    await pausa(esperas[i]);
  }
  return ultimo;
}

function registrarUso(qual, tamanho, tentativas, data) {
  const u = (data && data.usageMetadata) || {};
  console.log("USO " + qual
    + " msgs=" + tamanho
    + " tentativas=" + tentativas
    + " entrada=" + (u.promptTokenCount || 0)
    + " saida=" + (u.candidatesTokenCount || 0)
    + " total=" + (u.totalTokenCount || 0));
}
