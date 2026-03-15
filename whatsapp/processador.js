// ========== PROCESSADOR INTELIGENTE DE MENSAGENS WHATSAPP ==========
const { GoogleGenerativeAI } = require('@google/generative-ai');
const firestore = require('./firebase');
const whatsapp = require('./api');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// Cache de contexto de conversa (para perguntas de follow-up)
// chave: telefone, valor: { pendente: {...}, timestamp }
const conversas = new Map();

// Limpa conversas antigas a cada 30min
setInterval(() => {
    const agora = Date.now();
    for (const [tel, ctx] of conversas) {
        if (agora - ctx.timestamp > 30 * 60 * 1000) conversas.delete(tel);
    }
}, 30 * 60 * 1000);

// ========== PROMPT DO ASSISTENTE FINANCEIRO ==========
const SYSTEM_PROMPT = `Você é o Nexo, um assistente financeiro pessoal que conversa via WhatsApp.
Você deve ser simpático, objetivo e usar emojis com moderação. Escreva em português do Brasil.

SUAS CAPACIDADES:
1. REGISTRAR TRANSAÇÕES: O usuário pode dizer "gastei R$50 no mercado" e você registra.
2. CONSULTAR GASTOS: "quanto gastei esse mês?", "qual minha maior despesa?"
3. CONSULTAR SALDO: mostrar receitas - despesas do mês
4. CONSULTAR METAS: "como estão minhas metas?"
5. CONSULTAR DÍVIDAS: "tenho alguma dívida?"
6. CONSULTAR INVESTIMENTOS: "como estão meus investimentos?"
7. CONSULTAR CARTÕES: "qual o limite dos meus cartões?"
8. CONSULTAR LIMITES: "estourei algum limite de categoria?"
9. CONSULTAR CONTAS: "qual o saldo das minhas contas?"
10. RELATÓRIO MENSAL: resumo completo do mês
11. PROCESSAR MÍDIA: quando receber imagem/PDF de nota fiscal, cupom ou extrato, extrair transações

REGRAS DE CLASSIFICAÇÃO:
Ao receber uma mensagem do usuário, você DEVE responder EXCLUSIVAMENTE em JSON com este formato:
{
  "intent": "registrar|consultar_gastos|consultar_saldo|consultar_metas|consultar_dividas|consultar_investimentos|consultar_cartoes|consultar_limites|consultar_contas|relatorio|processar_midia|saudacao|ajuda|incompleto|conversa_geral",
  "dados": {
    "tipo": "receita|despesa",
    "descricao": "descrição da transação",
    "valor": 50.00,
    "categoria": "Mercado",
    "formaPagamento": "pix|dinheiro|credito|debito|boleto",
    "conta": "nome da conta",
    "dataReferencia": "YYYY-MM-DD",
    "camposFaltando": ["campo1", "campo2"]
  },
  "resposta": "Texto da resposta para o usuário",
  "perguntaFollowUp": "Pergunta para completar dados faltantes (se houver)"
}

REGRAS DE DADOS FALTANTES:
- Se o usuário disser o gasto mas NÃO disser a forma de pagamento, defina intent="incompleto" e pergunte no perguntaFollowUp.
- Se não disser a categoria, tente deduzir pelo contexto (ex: "pastel" → Restaurante, "gasolina" → Combustível, "mercado" → Mercado).
- Se disser "recebi R$5000 de salário", tipo="receita", categoria="Salário".
- A data padrão é HOJE se não for mencionada.

CATEGORIAS VÁLIDAS:
Salário, Freelancer, Investimentos, Outros (receitas)
Mercado, Delivery/Ifood, Restaurante, Padaria/Café, Combustível, Uber/Táxi, Farmácia, 
Roupas/Sapatos, Assinaturas/Streaming, Moradia, Água, Luz, Internet/TV, 
Academia/Esportes, Lazer, Saúde, Educação, Transporte, Pet, Eletrônicos, Presentes, Outros (despesas)

FORMAS DE PAGAMENTO VÁLIDAS: pix, dinheiro, credito, debito, boleto

IMPORTANTE: Responda SOMENTE o JSON. Sem texto extra, sem markdown, sem crases.`;

// ========== ANÁLISE DE MENSAGEM COM GEMINI ==========

async function analisarMensagem(texto, contextoConversa) {
    const hoje = new Date();
    const dataHoje = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;

    let promptExtra = `\nData de hoje: ${dataHoje}`;
    if (contextoConversa?.pendente) {
        promptExtra += `\nCONTEXTO ANTERIOR (dados incompletos pendentes): ${JSON.stringify(contextoConversa.pendente)}`;
        promptExtra += `\nO usuário está RESPONDENDO à pergunta anterior. Use os dados pendentes + a resposta para completar o registro.`;
    }

    const model = genAI.getGenerativeModel({
        model: 'gemini-2.0-flash',
        generationConfig: { responseMimeType: 'application/json', temperature: 0.2 }
    });

    const result = await model.generateContent([SYSTEM_PROMPT + promptExtra, texto]);
    const raw = result.response.text().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(raw);
}

// ========== ANÁLISE DE MÍDIA (IMAGEM/PDF) COM GEMINI ==========

async function analisarMidia(buffer, mimeType) {
    const PROMPT_MIDIA = `Você recebeu uma imagem/documento financeiro enviado via WhatsApp.
Extraia TODAS as transações encontradas.

Se for CUPOM FISCAL / NOTA FISCAL:
- Extraia cada item comprado com seu valor TOTAL (não unitário)
- Use a categoria "Mercado" para itens de supermercado
- A data é a data impressa no cupom

Se for EXTRATO BANCÁRIO ou FATURA DE CARTÃO:
- Extraia cada transação individual
- Classifique como receita ou despesa

Responda SOMENTE em JSON:
{
  "transacoes": [
    { "descricao": "...", "valor": 29.90, "tipo": "despesa", "categoria": "Mercado", "data": "DD/MM" }
  ],
  "totalGeral": 150.00,
  "resumo": "Resumo curto do documento em 1 frase"
}`;

    const model = genAI.getGenerativeModel({
        model: 'gemini-2.5-flash',
        generationConfig: { responseMimeType: 'application/json', temperature: 0.1 }
    });

    const result = await model.generateContent([
        PROMPT_MIDIA,
        { inlineData: { data: buffer.toString('base64'), mimeType } }
    ]);

    const raw = result.response.text().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
    return JSON.parse(raw);
}

// ========== FORMATADORES ==========

function fmt(v) { return (v || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' }); }

function nomesMes() {
    return ['Janeiro', 'Fevereiro', 'Março', 'Abril', 'Maio', 'Junho',
        'Julho', 'Agosto', 'Setembro', 'Outubro', 'Novembro', 'Dezembro'];
}

// ========== HANDLERS POR INTENT ==========

async function handleRegistrar(uid, telefone, analise) {
    const d = analise.dados;
    const hoje = new Date();
    const dataRef = d.dataReferencia || `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;

    const transacao = {
        tipo: d.tipo || 'despesa',
        descricao: d.descricao || 'Transação via WhatsApp',
        valor: d.valor || 0,
        categoria: d.categoria || 'Outros',
        formaPagamento: d.formaPagamento || 'pix',
        conta: d.conta || 'Conta Principal',
        pago: true,
        dataReferencia: dataRef,
        recorrente: false
    };

    await firestore.registrarTransacao(uid, transacao);
    await whatsapp.enviarTexto(telefone, analise.resposta || `✅ ${d.tipo === 'receita' ? 'Receita' : 'Despesa'} registrada!\n\n📝 ${transacao.descricao}\n💰 ${fmt(transacao.valor)}\n📂 ${transacao.categoria}\n💳 ${transacao.formaPagamento}`);
}

async function handleConsultarGastos(uid, telefone) {
    const hoje = new Date();
    const dados = await firestore.buscarTodasTransacoesMes(uid, hoje.getFullYear(), hoje.getMonth() + 1);
    const mesNome = nomesMes()[hoje.getMonth()];

    if (dados.despesas.length === 0) {
        return whatsapp.enviarTexto(telefone, `📊 Você não tem gastos registrados em ${mesNome} ainda.`);
    }

    // Agrupar por categoria
    const porCat = {};
    dados.despesas.forEach(d => {
        const cat = d.categoria || 'Outros';
        porCat[cat] = (porCat[cat] || 0) + (d.valor || 0);
    });

    const ranking = Object.entries(porCat).sort((a, b) => b[1] - a[1]);
    let msg = `📊 *Gastos de ${mesNome}*\n\n`;
    msg += `💸 Total: *${fmt(dados.totalDespesas)}*\n`;
    msg += `📋 ${dados.despesas.length} transações\n\n`;
    msg += `*Por categoria:*\n`;
    ranking.forEach(([cat, val]) => {
        const perc = ((val / dados.totalDespesas) * 100).toFixed(0);
        msg += `▪️ ${cat}: ${fmt(val)} (${perc}%)\n`;
    });

    await whatsapp.enviarTexto(telefone, msg);
}

async function handleConsultarSaldo(uid, telefone) {
    const hoje = new Date();
    const dados = await firestore.buscarTodasTransacoesMes(uid, hoje.getFullYear(), hoje.getMonth() + 1);
    const mesNome = nomesMes()[hoje.getMonth()];

    let msg = `💰 *Saldo de ${mesNome}*\n\n`;
    msg += `📈 Receitas: *${fmt(dados.totalReceitas)}*\n`;
    msg += `📉 Despesas: *${fmt(dados.totalDespesas)}*\n`;
    msg += `━━━━━━━━━━━━━━\n`;
    msg += `${dados.saldo >= 0 ? '✅' : '🔴'} Saldo: *${fmt(dados.saldo)}*`;

    await whatsapp.enviarTexto(telefone, msg);
}

async function handleConsultarMetas(uid, telefone) {
    const metas = await firestore.buscarMetas(uid);
    if (metas.length === 0) {
        return whatsapp.enviarTexto(telefone, '🎯 Você não tem metas cadastradas. Crie suas metas pelo app!');
    }

    let msg = '🎯 *Suas Metas*\n\n';
    metas.forEach(m => {
        const perc = m.valorAlvo > 0 ? ((m.valorAtual || 0) / m.valorAlvo * 100).toFixed(0) : 0;
        const falta = Math.max(0, m.valorAlvo - (m.valorAtual || 0));
        msg += `${m.icon || '🎯'} *${m.nome}*\n`;
        msg += `   ${fmt(m.valorAtual || 0)} / ${fmt(m.valorAlvo)} (${perc}%)\n`;
        msg += `   Falta: ${fmt(falta)}\n\n`;
    });

    await whatsapp.enviarTexto(telefone, msg);
}

async function handleConsultarDividas(uid, telefone) {
    const dividas = await firestore.buscarDividas(uid);
    if (dividas.length === 0) {
        return whatsapp.enviarTexto(telefone, '✅ Você não tem dívidas cadastradas!');
    }

    let msg = '📋 *Suas Dívidas*\n\n';
    let totalDevendo = 0;
    dividas.forEach(d => {
        const restante = d.valorTotal - (d.valorPago || 0);
        totalDevendo += restante;
        msg += `💳 *${d.nome || d.descricao}*\n`;
        msg += `   Total: ${fmt(d.valorTotal)} · Pago: ${fmt(d.valorPago || 0)}\n`;
        if (d.parcelas) msg += `   Parcelas: ${d.parcelasPagas || 0}/${d.parcelas}\n`;
        msg += `\n`;
    });
    msg += `━━━━━━━━━━━━━━\n💰 Total devendo: *${fmt(totalDevendo)}*`;

    await whatsapp.enviarTexto(telefone, msg);
}

async function handleConsultarInvestimentos(uid, telefone) {
    const investimentos = await firestore.buscarInvestimentos(uid);
    if (investimentos.length === 0) {
        return whatsapp.enviarTexto(telefone, '📈 Você não tem investimentos cadastrados.');
    }

    let msg = '📈 *Seus Investimentos*\n\n';
    let totalInvestido = 0;
    investimentos.forEach(inv => {
        totalInvestido += (inv.valor || 0);
        msg += `💎 *${inv.nome}*\n`;
        msg += `   Valor: ${fmt(inv.valor)} · Tipo: ${inv.tipo || 'Outros'}\n\n`;
    });
    msg += `━━━━━━━━━━━━━━\n💰 Total investido: *${fmt(totalInvestido)}*`;

    await whatsapp.enviarTexto(telefone, msg);
}

async function handleConsultarCartoes(uid, telefone) {
    const cartoes = await firestore.buscarCartoes(uid);
    if (cartoes.length === 0) {
        return whatsapp.enviarTexto(telefone, '💳 Você não tem cartões cadastrados.');
    }

    let msg = '💳 *Seus Cartões*\n\n';
    cartoes.forEach(c => {
        msg += `🏦 *${c.nome}*\n`;
        msg += `   Limite: ${fmt(c.limite)} · Fecha dia ${c.fechamento || '?'}\n\n`;
    });

    await whatsapp.enviarTexto(telefone, msg);
}

async function handleConsultarLimites(uid, telefone) {
    const hoje = new Date();
    const [limites, transacoes] = await Promise.all([
        firestore.buscarLimites(uid),
        firestore.buscarTransacoesMes(uid, hoje.getFullYear(), hoje.getMonth() + 1)
    ]);

    if (limites.length === 0) {
        return whatsapp.enviarTexto(telefone, '📏 Você não tem limites de categoria cadastrados.');
    }

    const despesas = transacoes.filter(t => t.tipo === 'despesa');
    let msg = '📏 *Limites de Categoria*\n\n';
    let algumEstourado = false;

    limites.forEach(lim => {
        const gasto = despesas.filter(d => d.categoria === lim.categoria).reduce((s, d) => s + (d.valor || 0), 0);
        const perc = lim.valor > 0 ? (gasto / lim.valor * 100).toFixed(0) : 0;
        const estourado = gasto > lim.valor;
        if (estourado) algumEstourado = true;

        msg += `${estourado ? '🔴' : '🟢'} *${lim.categoria}*\n`;
        msg += `   ${fmt(gasto)} / ${fmt(lim.valor)} (${perc}%)\n`;
        if (estourado) msg += `   ⚠️ Limite estourado!\n`;
        msg += '\n';
    });

    if (algumEstourado) msg += '⚠️ Atenção: você tem limites estourados!';

    await whatsapp.enviarTexto(telefone, msg);
}

async function handleConsultarContas(uid, telefone) {
    const contas = await firestore.buscarContas(uid);
    if (contas.length === 0) {
        return whatsapp.enviarTexto(telefone, '🏦 Você não tem contas cadastradas.');
    }

    let msg = '🏦 *Suas Contas*\n\n';
    let total = 0;
    contas.forEach(c => {
        total += (c.saldo || 0);
        msg += `${c.icon || '🏦'} *${c.nome}*\n   Saldo: ${fmt(c.saldo || 0)}\n\n`;
    });
    msg += `━━━━━━━━━━━━━━\n💰 Total: *${fmt(total)}*`;

    await whatsapp.enviarTexto(telefone, msg);
}

async function handleRelatorio(uid, telefone) {
    const hoje = new Date();
    const mesNome = nomesMes()[hoje.getMonth()];
    const dados = await firestore.buscarTodasTransacoesMes(uid, hoje.getFullYear(), hoje.getMonth() + 1);

    let msg = `📊 *Relatório de ${mesNome}*\n━━━━━━━━━━━━━━\n\n`;
    msg += `📈 Receitas: *${fmt(dados.totalReceitas)}*\n`;
    msg += `📉 Despesas: *${fmt(dados.totalDespesas)}*\n`;
    msg += `${dados.saldo >= 0 ? '✅' : '🔴'} Saldo: *${fmt(dados.saldo)}*\n\n`;

    if (dados.despesas.length > 0) {
        const porCat = {};
        dados.despesas.forEach(d => {
            const cat = d.categoria || 'Outros';
            porCat[cat] = (porCat[cat] || 0) + (d.valor || 0);
        });
        const ranking = Object.entries(porCat).sort((a, b) => b[1] - a[1]);
        msg += `*Top Gastos por Categoria:*\n`;
        ranking.slice(0, 5).forEach(([cat, val], i) => {
            msg += `${i + 1}. ${cat}: ${fmt(val)}\n`;
        });

        // Maior gasto individual
        const maior = dados.despesas.reduce((a, b) => (b.valor || 0) > (a.valor || 0) ? b : a);
        msg += `\n💸 Maior gasto: *${maior.descricao || 'Sem descrição'}* - ${fmt(maior.valor)}`;
    }

    msg += `\n\n📋 Total de ${dados.transacoes.length} transações no mês.`;

    await whatsapp.enviarTexto(telefone, msg);
}

async function handleMidia(uid, telefone, buffer, mimeType) {
    await whatsapp.enviarTexto(telefone, '🔍 Analisando seu documento... aguarde um momento.');

    const resultado = await analisarMidia(buffer, mimeType);

    if (!resultado.transacoes || resultado.transacoes.length === 0) {
        return whatsapp.enviarTexto(telefone, '❌ Não consegui identificar transações neste documento. Tente enviar uma foto mais nítida.');
    }

    // Registra todas as transações no Firestore
    const hoje = new Date();
    let totalRegistrado = 0;

    for (const t of resultado.transacoes) {
        let dataRef;
        if (t.data && t.data.includes('/')) {
            const [dia, mes] = t.data.split('/');
            dataRef = `${hoje.getFullYear()}-${mes.padStart(2, '0')}-${dia.padStart(2, '0')}`;
        } else {
            dataRef = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}-${String(hoje.getDate()).padStart(2, '0')}`;
        }

        await firestore.registrarTransacao(uid, {
            tipo: t.tipo || 'despesa',
            descricao: t.descricao || 'Item',
            valor: Math.abs(t.valor || 0),
            categoria: t.categoria || 'Outros',
            formaPagamento: 'credito',
            conta: 'Conta Principal',
            pago: true,
            dataReferencia: dataRef,
            recorrente: false
        });
        totalRegistrado += Math.abs(t.valor || 0);
    }

    let msg = `✅ *Documento processado!*\n\n`;
    msg += `📋 ${resultado.transacoes.length} transações registradas\n`;
    msg += `💰 Total: *${fmt(totalRegistrado)}*\n`;
    if (resultado.resumo) msg += `\n📝 ${resultado.resumo}`;

    await whatsapp.enviarTexto(telefone, msg);
}

async function handleIncompleto(telefone, analise) {
    // Salva dados parciais no cache de conversa
    conversas.set(telefone, {
        pendente: analise.dados,
        timestamp: Date.now()
    });

    const pergunta = analise.perguntaFollowUp || analise.resposta || 'Pode completar as informações?';

    // Se tiver opções claras, envia como botões
    const campos = analise.dados?.camposFaltando || [];
    if (campos.includes('formaPagamento')) {
        await whatsapp.enviarBotoes(telefone, pergunta, [
            { id: 'pag_pix', titulo: '💠 Pix' },
            { id: 'pag_credito', titulo: '💳 Crédito' },
            { id: 'pag_dinheiro', titulo: '💵 Dinheiro' }
        ]);
    } else {
        await whatsapp.enviarTexto(telefone, pergunta);
    }
}

function getMensagemAjuda() {
    return `🤖 *Olá! Sou o Nexo, seu assistente financeiro.*\n\nAqui está o que posso fazer por você:\n\n` +
        `💰 *Registrar gastos/receitas*\n   Ex: "Gastei R$50 no mercado"\n   Ex: "Recebi R$5000 de salário"\n\n` +
        `📊 *Consultar finanças*\n   Ex: "Quanto gastei esse mês?"\n   Ex: "Qual meu saldo?"\n   Ex: "Meu relatório do mês"\n\n` +
        `🎯 *Consultar metas, dívidas, investimentos*\n   Ex: "Como estão minhas metas?"\n   Ex: "Tenho alguma dívida?"\n\n` +
        `💳 *Consultar cartões e limites*\n   Ex: "Qual limite dos cartões?"\n   Ex: "Estourei algum limite?"\n\n` +
        `📸 *Enviar documentos*\n   Mande uma foto de nota fiscal, cupom ou PDF que eu registro tudo automaticamente!\n\n` +
        `Pode me perguntar qualquer coisa sobre suas finanças! 😊`;
}

// ========== PROCESSADOR PRINCIPAL ==========

async function processarMensagem(telefone, messageId, texto, midia) {
    try {
        // Marca como lida
        await whatsapp.marcarComoLida(messageId);

        // 1. Identifica o usuário
        const usuario = await firestore.encontrarUsuarioPorWhatsApp(telefone);
        if (!usuario) {
            return whatsapp.enviarTexto(telefone,
                '❌ Seu número não está vinculado a uma conta Nexo.\n\n' +
                'Para vincular, acesse o app Nexo → Configurações → WhatsApp e conecte seu número.');
        }

        // 2. Verifica plano
        if (!firestore.temPlanoWhatsApp(usuario)) {
            return whatsapp.enviarTexto(telefone,
                '⭐ O assistente WhatsApp é exclusivo do plano *Nexo Pro*.\n\n' +
                'Faça upgrade no app para desbloquear esta funcionalidade!');
        }

        const uid = usuario.uid;

        // 3. Se for mídia (imagem/PDF), processa direto
        if (midia) {
            const { buffer, mimeType } = await whatsapp.baixarMidia(midia.id);
            return handleMidia(uid, telefone, buffer, mimeType);
        }

        // 4. Se não tem texto, ignora
        if (!texto || !texto.trim()) return;

        // 5. Verifica se tem conversa pendente (follow-up)
        const contexto = conversas.get(telefone) || null;

        // 6. Analisa com Gemini
        const analise = await analisarMensagem(texto, contexto);

        // Limpa contexto após uso
        if (contexto) conversas.delete(telefone);

        // 7. Roteia para o handler correto
        switch (analise.intent) {
            case 'registrar':
                return handleRegistrar(uid, telefone, analise);
            case 'consultar_gastos':
                return handleConsultarGastos(uid, telefone);
            case 'consultar_saldo':
                return handleConsultarSaldo(uid, telefone);
            case 'consultar_metas':
                return handleConsultarMetas(uid, telefone);
            case 'consultar_dividas':
                return handleConsultarDividas(uid, telefone);
            case 'consultar_investimentos':
                return handleConsultarInvestimentos(uid, telefone);
            case 'consultar_cartoes':
                return handleConsultarCartoes(uid, telefone);
            case 'consultar_limites':
                return handleConsultarLimites(uid, telefone);
            case 'consultar_contas':
                return handleConsultarContas(uid, telefone);
            case 'relatorio':
                return handleRelatorio(uid, telefone);
            case 'incompleto':
                return handleIncompleto(telefone, analise);
            case 'saudacao':
            case 'ajuda':
                return whatsapp.enviarTexto(telefone, getMensagemAjuda());
            case 'conversa_geral':
            default:
                return whatsapp.enviarTexto(telefone, analise.resposta || 'Desculpe, não entendi. Digite *ajuda* para ver o que posso fazer!');
        }

    } catch (error) {
        console.error('❌ Erro ao processar mensagem WhatsApp:', error);
        try {
            await whatsapp.enviarTexto(telefone, '⚠️ Ops, tive um problema ao processar sua mensagem. Tente novamente em instantes.');
        } catch (e) { /* silencia */ }
    }
}

module.exports = { processarMensagem };
