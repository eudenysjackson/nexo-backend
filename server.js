require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
const upload = multer({ storage: multer.memoryStorage() });

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

app.get('/ping', (req, res) => {
    console.log("🟢 ALGUÉM ACESSOU O SERVIDOR PELO NAVEGADOR!");
    res.send("O servidor do Nexo está vivo e escutando!");
});

app.post('/api/extrair-fatura', upload.single('arquivo'), async (req, res) => {
    console.log("🟡 RECEBI UM ARQUIVO DO SEU SITE! Lendo a imagem (Modo Turbo)...");
    
    try {
        if (!req.file) {
            return res.status(400).json({ erro: 'Nenhum arquivo foi enviado.' });
        }

        const prompt = `Atue como extrator de dados financeiros. 
        Analise a imagem em anexo. Extraia as despesas.
        O formato de saída DEVE ser estritamente um array de objetos. 
        Propriedades do objeto:
        "desc" (string: nome do gasto), 
        "valor" (number: valor float usando ponto para decimais), 
        "data" (string: formato DD/MM), 
        "cat" (string: categorizado APENAS entre: Alimentação, Transporte, Assinaturas, Lazer, Moradia, Saúde, Educação, Compras, Serviços, Outros).`;

        const imageParts = [{
            inlineData: {
                data: req.file.buffer.toString("base64"),
                mimeType: req.file.mimetype
            }
        }];

        let result;
        
        try {
            console.log("⏳ Extraindo dados com Gemini 2.5 Flash...");
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                // ⚡ O SEGREDO DA VELOCIDADE: Força a resposta ser JSON puro e tira a criatividade
                generationConfig: {
                    responseMimeType: "application/json",
                    temperature: 0.1 
                }
            });
            result = await model.generateContent([prompt, ...imageParts]);
        } catch (err1) {
            console.log("⚠️ Tentando Plano B (Modelo 2.0 Flash)...");
            const modelFallback = genAI.getGenerativeModel({ 
                model: "gemini-2.0-flash",
                generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
            });
            result = await modelFallback.generateContent([prompt, ...imageParts]);
        }

        // Como forçamos o responseMimeType, não precisamos mais limpar crases e markdown!
        const transacoes = JSON.parse(result.response.text());

        console.log("✅ IA PROCESSOU COM SUCESSO E MAIS RÁPIDO! Devolvendo pro site...");
        res.json(transacoes);

    } catch (error) {
        console.error("🔴 ERRO PESADO NA IA:", error);
        res.status(500).json({ erro: 'Erro ao processar o documento com a Inteligência Artificial.' });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Servidor Nexo IA rodando perfeitamente na porta ${PORT} 🚀`);
});