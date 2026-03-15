// ========== WHATSAPP CLOUD API - ENVIO DE MENSAGENS ==========
const axios = require('axios');

const WHATSAPP_API_URL = 'https://graph.facebook.com/v21.0';

function getHeaders() {
    return {
        'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}`,
        'Content-Type': 'application/json'
    };
}

// Envia mensagem de texto simples
async function enviarTexto(telefone, texto) {
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    await axios.post(`${WHATSAPP_API_URL}/${phoneId}/messages`, {
        messaging_product: 'whatsapp',
        to: telefone,
        type: 'text',
        text: { body: texto }
    }, { headers: getHeaders() });
}

// Envia mensagem com botões de resposta rápida (máximo 3 botões)
async function enviarBotoes(telefone, texto, botoes) {
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    const buttons = botoes.slice(0, 3).map((b, i) => ({
        type: 'reply',
        reply: { id: b.id || `btn_${i}`, title: String(b.titulo).substring(0, 20) }
    }));

    await axios.post(`${WHATSAPP_API_URL}/${phoneId}/messages`, {
        messaging_product: 'whatsapp',
        to: telefone,
        type: 'interactive',
        interactive: {
            type: 'button',
            body: { text: texto },
            action: { buttons }
        }
    }, { headers: getHeaders() });
}

// Envia lista de opções (até 10 itens)
async function enviarLista(telefone, texto, tituloBtn, secoes) {
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    await axios.post(`${WHATSAPP_API_URL}/${phoneId}/messages`, {
        messaging_product: 'whatsapp',
        to: telefone,
        type: 'interactive',
        interactive: {
            type: 'list',
            body: { text: texto },
            action: {
                button: tituloBtn,
                sections: secoes
            }
        }
    }, { headers: getHeaders() });
}

// Marca mensagem como lida
async function marcarComoLida(messageId) {
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    try {
        await axios.post(`${WHATSAPP_API_URL}/${phoneId}/messages`, {
            messaging_product: 'whatsapp',
            status: 'read',
            message_id: messageId
        }, { headers: getHeaders() });
    } catch (e) { /* silencia erro de read receipt */ }
}

// Baixa mídia do WhatsApp (imagem, PDF, áudio, etc.)
async function baixarMidia(mediaId) {
    // 1. Pega URL da mídia
    const info = await axios.get(`${WHATSAPP_API_URL}/${mediaId}`, { headers: getHeaders() });
    const mediaUrl = info.data.url;
    const mimeType = info.data.mime_type;

    // 2. Baixa o arquivo
    const resp = await axios.get(mediaUrl, {
        headers: getHeaders(),
        responseType: 'arraybuffer'
    });

    return { buffer: Buffer.from(resp.data), mimeType };
}

module.exports = {
    enviarTexto, enviarBotoes, enviarLista,
    marcarComoLida, baixarMidia
};
