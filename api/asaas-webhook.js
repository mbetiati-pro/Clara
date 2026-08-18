// Recebe os avisos do Asaas e marca o pagamento na planilha.
//
// O externalReference carrega o id da conversa, e e ele que liga o pagamento
// a linha certa. Sem isso nao existe "quem pagou": so existe "alguem pagou".
//
// O Asaas entrega no modelo "at least once" - o mesmo evento pode chegar mais
// de uma vez. Aqui isso e inofensivo porque a gravacao e sempre o mesmo valor
// no mesmo id: reescrever "SIM" por cima de "SIM" nao muda nada.
//
// Responde 200 em praticamente todos os casos, de proposito. Se este endpoint
// devolver erro, o Asaas pausa a fila de webhooks da conta inteira e voce para
// de receber aviso de pagamento sem perceber.

const PAGOU = { PAYMENT_CONFIRMED: 1, PAYMENT_RECEIVED: 1, CHECKOUT_PAID: 1 };
const FALHOU = { PAYMENT_REPROVED_BY_RISK_ANALYSIS: 1, PAYMENT_REFUNDED: 1, PAYMENT_CHARGEBACK_REQUESTED: 1 };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Metodo nao permitido" });
  }

  try {
    const esperado = process.env.ASAAS_WEBHOOK_TOKEN;
    const recebido = req.headers["asaas-access-token"];
    if (!esperado || recebido !== esperado) {
      console.log("WEBHOOK RECUSADO token invalido ou ausente");
      return res.status(401).json({ error: "nao autorizado" });
    }

    const body = req.body || {};
    const evento = String(body.event || "");
    const pagamento = body.payment || body.checkout || {};

    // O Asaas Checkout NAO propaga o externalReference para a cobranca gerada:
    // no objeto payment ele vem null. O que liga o pagamento a conversa e o
    // checkoutSession, que e o mesmo id que o checkout.js gravou na coluna
    // Cobranca. Por isso a busca tem dois caminhos.
    const ref = String(pagamento.externalReference || "").trim();
    const sessao = String(pagamento.checkoutSession || pagamento.id || "").trim();

    if (!ref && !sessao) {
      console.log("WEBHOOK SEM REFERENCIA evento=" + evento);
      return res.status(200).json({ ok: true, ignorado: "sem referencia nem checkoutSession" });
    }

    let pago = "";
    if (PAGOU[evento]) pago = "SIM";
    else if (FALHOU[evento]) pago = "RECUSADO";
    else {
      console.log("WEBHOOK IGNORADO evento=" + evento + " id=" + ref);
      return res.status(200).json({ ok: true, ignorado: evento });
    }

    // Com externalReference, casa pelo id da conversa. Sem ele, casa pela
    // coluna Cobranca usando o checkoutSession.
    const linha = ref
      ? { id: ref, pago: pago, cobranca: sessao }
      : { cobranca: sessao, pago: pago };

    const url = process.env.SHEETS_URL;
    if (url) {
      const r = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(linha)
      });
      let ok = false;
      try {
        const d = await r.json();
        ok = !!(d && d.ok);
      } catch (e) {
        ok = false;
      }
      console.log("WEBHOOK " + evento + " ref=" + (ref || "-") + " sessao=" + (sessao || "-")
        + " pago=" + pago + " planilha=" + (ok ? "ok" : "FALHOU"));
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.log("WEBHOOK ERRO " + String(err).slice(0, 300));
    return res.status(200).json({ ok: true, erro: "tratado" });
  }
}
