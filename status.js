// Diz para a conversa se o pagamento daquele id ja foi confirmado.
//
// Quem confirma pagamento e o webhook do Asaas, nunca o retorno da guia do
// navegador. A pessoa pode voltar para a conversa antes de o dinheiro cair,
// e o cartao pode ate ser recusado depois - por isso a Clara pergunta aqui
// em vez de assumir que deu certo so porque a pessoa voltou.

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ error: "Metodo nao permitido" });
  }

  const url = process.env.SHEETS_URL;
  if (!url) return res.status(500).json({ error: "SHEETS_URL nao configurada." });

  const id = String((req.query && req.query.id) || "").trim();
  if (!id || id.length > 80) {
    return res.status(400).json({ error: "id invalido" });
  }

  try {
    const r = await fetch(url + "?acao=status&id=" + encodeURIComponent(id), { method: "GET" });

    // Se a implantacao do Apps Script estiver com acesso restrito, o Google
    // devolve uma pagina HTML de login com status 200. Sem parse estrito isso
    // passaria como sucesso silencioso - foi exatamente o que mascarou uma
    // falha de gravacao antes.
    let dados = null;
    try {
      dados = await r.json();
    } catch (e) {
      console.log("STATUS resposta nao-JSON da planilha id=" + id + " http=" + r.status);
      return res.status(200).json({ ok: false, motivo: "planilha indisponivel" });
    }

    if (!dados || dados.ok !== true) {
      return res.status(200).json({ ok: false, motivo: "consulta recusada" });
    }

    return res.status(200).json({
      ok: true,
      encontrado: dados.encontrado === true,
      pago: String(dados.pago || ""),
      cobranca: String(dados.cobranca || "")
    });
  } catch (err) {
    console.log("STATUS ERRO id=" + id + " " + String(err).slice(0, 200));
    return res.status(200).json({ ok: false, motivo: "falha interna" });
  }
}
