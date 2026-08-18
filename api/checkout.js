// Cria um checkout hospedado no Asaas para uma conversa especifica.
// O pagamento acontece INTEIRAMENTE na pagina do Asaas: nenhum dado de cartao
// passa por aqui. O que amarra o pagamento a conversa e o externalReference,
// que volta dentro do webhook.
//
// Pode ser chamado mais de uma vez para a mesma conversa. O checkout do Asaas
// expira em no maximo 24 horas, entao gerar um link novo e o comportamento
// esperado quando a pessoa volta depois ou avisa que o link expirou.

const VALOR = 3907;
const NOME_ITEM = "Planejamento para Neg\u00f3cios";
const MAX_PARCELAS = 3;
const MINUTOS_VALIDADE = 1440; // teto do Asaas

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metodo nao permitido" });
  }

  const chave = process.env.ASAAS_API_KEY;
  const base = process.env.ASAAS_API_URL || "https://api-sandbox.asaas.com/v3";
  if (!chave) return res.status(500).json({ error: "ASAAS_API_KEY nao configurada." });

  try {
    const body = req.body || {};
    const id = String(body.id || "").trim();
    if (!id) return res.status(400).json({ error: "Conversa sem id." });

    const origem = String(body.origem || "direto").toLowerCase().replace(/[^a-z0-9_-]/g, "");

    // O dominio de retorno vem do host da propria requisicao, nao de texto fixo.
    // Se voltar pra mariaclara.ai quando a conversa rodou em www.mariaclara.ai,
    // o localStorage e outro e a pessoa cai numa conversa vazia depois de pagar.
    const host = String(req.headers["x-forwarded-host"] || req.headers.host || "www.mariaclara.ai");
    const volta = "https://" + host + "/" + (origem && origem !== "direto" ? origem : "");

    const pacote = {
      billingTypes: ["PIX", "CREDIT_CARD"],
      chargeTypes: ["DETACHED", "INSTALLMENT"],
      minutesToExpire: MINUTOS_VALIDADE,
      externalReference: id,
      callback: {
        successUrl: volta + "?pg=ok",
        cancelUrl: volta + "?pg=cancel",
        expiredUrl: volta + "?pg=exp"
      },
      items: [{
        name: NOME_ITEM,
        description: "Duas reuni\u00f5es online com o Marcos Betiati e a entrega do plano em at\u00e9 10 dias \u00fateis.",
        quantity: 1,
        value: VALOR
      }],
      installment: { maxInstallmentCount: MAX_PARCELAS }
    };

    // customerData fica de FORA de proposito. Ele e opcional e serve so pra
    // pre-preencher o checkout. Mandando parcial (so nome, e-mail e telefone),
    // o Asaas passa a exigir o cadastro completo: cpfCnpj, address,
    // addressNumber, postalCode e province. Nada disso a Clara tem, e pedir
    // CPF e endereco no meio da conversa seria fricção e dado sensivel sem
    // necessidade. Sem o objeto, a pagina do Asaas coleta o que precisar.

    const r = await fetch(base + "/checkouts", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "accept": "application/json",
        "access_token": chave
      },
      body: JSON.stringify(pacote)
    });

    let dados = {};
    try { dados = await r.json(); } catch (e) { dados = {}; }

    if (!r.ok || !dados.link) {
      // Registrar o payload enviado ajuda a diagnosticar os 400 do Asaas.
      console.log("CHECKOUT FALHA id=" + id + " status=" + r.status
        + " resposta=" + JSON.stringify(dados).slice(0, 500)
        + " enviado=" + JSON.stringify(pacote).slice(0, 500));
      return res.status(200).json({ ok: false, motivo: "asaas recusou" });
    }

    console.log("CHECKOUT CRIADO id=" + id + " checkout=" + dados.id + " expira_em=" + MINUTOS_VALIDADE + "min");

    // Guarda o id do checkout na planilha. Payload parcial: o Apps Script
    // preserva as colunas que nao vierem preenchidas.
    registrarNaPlanilha({ id: id, cobranca: String(dados.id || "") });

    return res.status(200).json({ ok: true, link: dados.link, checkout: dados.id });
  } catch (err) {
    console.log("CHECKOUT ERRO " + String(err).slice(0, 300));
    return res.status(200).json({ ok: false, motivo: "falha interna" });
  }
}

// Sem await de proposito: a gravacao na planilha nao pode atrasar a entrega
// do link para quem esta esperando na conversa.
function registrarNaPlanilha(linha) {
  const url = process.env.SHEETS_URL;
  if (!url) return;
  fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(linha)
  }).catch(function () {});
}
