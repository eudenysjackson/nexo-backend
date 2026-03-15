require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(express.json());
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// ========== PARSERS DE FORMATO ==========

// Parser OFX (formato bancário padrão)
function parseOFX(text) {
    const transacoes = [];
    const regex = /<STMTTRN>([\s\S]*?)<\/STMTTRN>/gi;
    let match;
    while ((match = regex.exec(text)) !== null) {
        const bloco = match[1];
        const tipo = (bloco.match(/<TRNTYPE>(.*)/i) || [])[1]?.trim();
        const dtStr = (bloco.match(/<DTPOSTED>(\d{8})/i) || [])[1];
        const valor = parseFloat((bloco.match(/<TRNAMT>([\-\d.,]+)/i) || [])[1]?.replace(',', '.')) || 0;
        const desc = (bloco.match(/<MEMO>(.*)/i) || (bloco.match(/<NAME>(.*)/i)) || [])[1]?.trim() || 'Sem descrição';

        let data = '--/--';
        if (dtStr) {
            data = `${dtStr.substring(6, 8)}/${dtStr.substring(4, 6)}`;
        }

        transacoes.push({
            desc: desc,
            valor: Math.abs(valor),
            data: data,
            tipo: valor < 0 ? 'despesa' : 'receita',
            cat: 'Outros'
        });
    }
    return transacoes;
}

// Parser CSV (Nubank, Inter, Itaú, genérico)
function parseCSV(text) {
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    if (lines.length < 2) return null; // null = não é CSV válido

    const sep = lines[0].includes(';') ? ';' : ',';
    const header = lines[0].toLowerCase();

    // Detecta se é realmente CSV com cabeçalho financeiro
    if (!header.includes('data') && !header.includes('date') && !header.includes('valor') && !header.includes('amount') && !header.includes('descri')) {
        return null;
    }

    const cols = lines[0].split(sep).map(c => c.trim().replace(/^"|"$/g, '').toLowerCase());
    const iData = cols.findIndex(c => c.includes('data') || c.includes('date'));
    const iDesc = cols.findIndex(c => c.includes('descri') || c.includes('title') || c.includes('memo') || c.includes('estabelecimento') || c.includes('nome'));
    const iValor = cols.findIndex(c => c.includes('valor') || c.includes('amount') || c.includes('quantia'));

    if (iDesc === -1 || iValor === -1) return null;

    const transacoes = [];
    for (let i = 1; i < lines.length; i++) {
        const row = lines[i].split(sep).map(c => c.trim().replace(/^"|"$/g, ''));
        if (row.length < Math.max(iDesc, iValor) + 1) continue;

        let valorStr = row[iValor].replace(/[R$\s]/g, '');
        // Formato brasileiro: 1.234,56 → 1234.56
        if (valorStr.includes(',')) {
            valorStr = valorStr.replace(/\./g, '').replace(',', '.');
        }
        const valor = parseFloat(valorStr);
        if (isNaN(valor)) continue;

        let data = '--/--';
        if (iData >= 0 && row[iData]) {
            const d = row[iData];
            if (/^\d{4}-\d{2}-\d{2}/.test(d)) {
                data = `${d.substring(8, 10)}/${d.substring(5, 7)}`;
            } else if (/^\d{2}\/\d{2}/.test(d)) {
                data = d.substring(0, 5);
            }
        }

        transacoes.push({
            desc: row[iDesc] || 'Sem descrição',
            valor: Math.abs(valor),
            data: data,
            tipo: valor < 0 ? 'despesa' : 'receita',
            cat: 'Outros'
        });
    }
    return transacoes.length > 0 ? transacoes : null;
}

// ========== PROMPT PARA GEMINI (melhorado) ==========
const PROMPT_EXTRATOR = `Você é um extrator de transações financeiras brasileiras altamente preciso.

REGRAS OBRIGATÓRIAS:
1. Extraia APENAS transações/compras/gastos reais. NÃO inclua: totais, subtotais, pagamentos de fatura, IOF, encargos rotativos, juros, multas, créditos, estornos, limite disponível.
2. Se for uma fatura de cartão de crédito, extraia SOMENTE as compras/parcelas individuais.
3. Se for print de conversa de WhatsApp/chat com valores financeiros, extraia os valores mencionados como transações.
4. Se for extrato bancário, extraia cada movimentação (débitos como despesa, créditos como receita).
5. Se for NOTA FISCAL / CUPOM FISCAL DE SUPERMERCADO / COMPRAS:
   - Cada linha de item tem: CÓDIGO, DESCRIÇÃO, QTD, UN, VL.UNIT, VL.TOTAL
   - Abaixo da descrição pode ter uma linha auxiliar com "QTD x VL.UNIT" (ex: "4,000 UN x 19,49")
   - SEMPRE use o VL.TOTAL (valor já multiplicado pela quantidade) como "valor" de cada item. NUNCA use o VL.UNIT (preço unitário).
   - Se houver linhas com QTD fracionada (ex: 1,114 KG x 21,49), o VL.TOTAL virá na mesma linha ou logo abaixo — use esse VL.TOTAL.
   - NÃO inclua a linha final de "QTD. TOTAL DE ITENS", "VALOR TOTAL R$", "VALOR A PAGAR", "FORMA DE PAGAMENTO", etc.
   - NÃO duplique itens lendo a mesma linha duas vezes.
   - A SOMA de todos os "valor" deve ser IGUAL ao total da nota. Se você perceber discrepância, revise os valores extraídos.

FORMATO DE SAÍDA (JSON array, sem texto extra):
[{
  "desc": "Nome do estabelecimento ou descrição",
  "valor": 29.90,
  "data": "DD/MM",
  "cat": "Categoria"
}]

CATEGORIAS PERMITIDAS (use EXATAMENTE estas):
Aluguel, Condomínio, Água, Luz, Gás, Internet/TV, Manutenção da Casa,
Mercado, Delivery/Ifood, Restaurante, Padaria/Café,
Combustível, Uber/Táxi, Ônibus/Metrô, Estacionamento, Manutenção Veículo, Pedágio,
Plano de Saúde, Farmácia, Consultas/Exames, Dentista,
Faculdade/Escola, Cursos,
Cinema/Teatro, Viagens, Bares/Baladas, Jogos/Games,
Roupas/Sapatos, Academia/Esportes, Salão/Barbearia, Cosméticos, Presentes, Eletrônicos, Pet,
Assinaturas/Streaming, Taxas Bancárias, Empréstimos/Dívidas,
Outros

DICAS DE CATEGORIZAÇÃO:
- Uber, 99, Cabify → Uber/Táxi
- iFood, Rappi → Delivery/Ifood
- Netflix, Spotify, Disney+, Google Workspace, YouTube, ChatGPT → Assinaturas/Streaming
- Supermercado, Carrefour, Assaí → Mercado
- Cantina, Pizzaria, Restaurante → Restaurante
- Shell, Ipiranga, Posto → Combustível
- Drogaria, Farmácia, Drogasil → Farmácia

Responda SOMENTE com o array JSON. Sem explicações.`;

// ========== ROTAS ==========

app.get('/ping', (req, res) => {
    console.log("🟢 Servidor acessado!");
    res.send("Nexo Backend v2 - PDF, Imagem, CSV, OFX, WhatsApp");
});

// Rota principal: extrai transações de qualquer formato
app.post('/api/extrair-fatura', upload.single('arquivo'), async (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ erro: 'Nenhum arquivo foi enviado.' });
        }

        const { originalname, mimetype, buffer } = req.file;
        const ext = originalname.toLowerCase().split('.').pop();
        console.log(`📥 Arquivo recebido: ${originalname} (${mimetype}, ${(buffer.length / 1024).toFixed(1)}KB)`);

        // ---- OFX: parser local, sem IA ----
        if (ext === 'ofx' || ext === 'qfx') {
            console.log("📄 Processando OFX...");
            const text = buffer.toString('utf-8');
            const transacoes = parseOFX(text);
            if (transacoes.length === 0) {
                return res.status(400).json({ erro: 'Nenhuma transação encontrada no arquivo OFX.' });
            }
            console.log(`✅ OFX: ${transacoes.length} transações extraídas`);
            return res.json(transacoes);
        }

        // ---- CSV: parser local, sem IA ----
        if (ext === 'csv' || mimetype === 'text/csv') {
            console.log("📄 Processando CSV...");
            const text = buffer.toString('utf-8');
            const transacoes = parseCSV(text);
            if (transacoes && transacoes.length > 0) {
                console.log(`✅ CSV: ${transacoes.length} transações extraídas`);
                return res.json(transacoes);
            }
            // Se não conseguiu parsear como CSV estruturado, manda pra IA como texto
            console.log("⚠️ CSV não-padrão, enviando como texto para IA...");
            return await processarComIA(text, null, res);
        }

        // ---- PDF: envia como binário pra IA ----
        if (ext === 'pdf' || mimetype === 'application/pdf') {
            console.log("📄 Processando PDF com IA...");
            return await processarComIA(null, { data: buffer.toString('base64'), mimeType: 'application/pdf' }, res);
        }

        // ---- Imagens (prints, fotos, screenshots, WhatsApp): envia pra IA ----
        if (mimetype.startsWith('image/')) {
            console.log("🖼️ Processando imagem com IA...");
            return await processarComIA(null, { data: buffer.toString('base64'), mimeType: mimetype }, res);
        }

        // ---- Texto puro ----
        if (mimetype.startsWith('text/') || ext === 'txt') {
            console.log("📝 Processando texto com IA...");
            const text = buffer.toString('utf-8');
            return await processarComIA(text, null, res);
        }

        return res.status(400).json({ erro: `Formato não suportado: ${ext}` });

    } catch (error) {
        console.error("🔴 ERRO:", error.message || error);
        res.status(500).json({ erro: 'Erro ao processar o documento.' });
    }
});

// ========== PROCESSAMENTO COM GEMINI ==========
async function processarComIA(texto, arquivo, res) {
    const parts = [PROMPT_EXTRATOR];

    if (arquivo) {
        parts.push({ inlineData: arquivo });
    }
    if (texto) {
        parts.push(`\n\nConteúdo do documento:\n${texto.substring(0, 50000)}`);
    }

    let result;
    try {
        console.log("⏳ Enviando para Gemini 2.5 Flash...");
        const model = genAI.getGenerativeModel({
            model: "gemini-2.5-flash",
            generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
        });
        result = await model.generateContent(parts);
    } catch (err1) {
        console.log("⚠️ Fallback: Gemini 2.0 Flash...");
        const modelFallback = genAI.getGenerativeModel({
            model: "gemini-2.0-flash",
            generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
        });
        result = await modelFallback.generateContent(parts);
    }

    let transacoes;
    try {
        transacoes = JSON.parse(result.response.text());
    } catch (e) {
        // Tenta limpar caso a IA retorne markdown com crases
        const raw = result.response.text().replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        transacoes = JSON.parse(raw);
    }

    if (!Array.isArray(transacoes)) {
        return res.status(400).json({ erro: 'IA não retornou transações válidas.' });
    }

    // Garante formato consistente
    transacoes = transacoes.map(t => ({
        desc: String(t.desc || t.descricao || t.nome || 'Sem descrição').substring(0, 100),
        valor: Math.abs(parseFloat(t.valor || t.value || 0)),
        data: String(t.data || t.date || '--/--').substring(0, 5),
        cat: String(t.cat || t.categoria || t.category || 'Outros')
    })).filter(t => t.valor > 0);

    console.log(`✅ IA extraiu ${transacoes.length} transações`);
    res.json(transacoes);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Nexo Backend v2 rodando na porta ${PORT} 🚀`);
    console.log("Formatos suportados: PDF, Imagem, CSV, OFX, Print de WhatsApp");
});