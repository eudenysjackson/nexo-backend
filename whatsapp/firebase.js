// ========== FIREBASE ADMIN SDK ==========
const admin = require('firebase-admin');

// Inicializa com credenciais do ambiente (service account JSON)
let db = null;
try {
    if (!admin.apps.length) {
        const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
        if (raw && raw !== '{}') {
            const serviceAccount = JSON.parse(raw);
            admin.initializeApp({
                credential: admin.credential.cert(serviceAccount)
            });
            db = admin.firestore();
            console.log('✅ Firebase Admin inicializado');
        } else {
            console.warn('⚠️ FIREBASE_SERVICE_ACCOUNT não configurado — WhatsApp desativado');
        }
    } else {
        db = admin.firestore();
    }
} catch (e) {
    console.error('🔴 Erro ao inicializar Firebase Admin:', e.message);
}

// ========== FUNÇÕES DE BUSCA DE USUÁRIO ==========

// Encontra o UID do Nexo pelo número de WhatsApp vinculado
async function encontrarUsuarioPorWhatsApp(telefoneWA) {
    const snap = await db.collection('usuarios')
        .where('whatsappVinculado', '==', telefoneWA)
        .limit(1)
        .get();
    if (snap.empty) return null;
    const doc = snap.docs[0];
    return { uid: doc.id, ...doc.data() };
}

// Verifica se o plano do usuário permite WhatsApp
function temPlanoWhatsApp(userData) {
    const plano = (userData.plano || '').toLowerCase();
    return plano === 'pro' || plano === 'plus' || plano === 'premium';
}

// ========== CRUD TRANSAÇÕES ==========

async function registrarTransacao(uid, dados) {
    const ref = db.collection('usuarios').doc(uid).collection('transacoes');
    const doc = await ref.add({
        ...dados,
        dataCriacao: admin.firestore.FieldValue.serverTimestamp(),
        origem: 'whatsapp'
    });
    return doc.id;
}

async function buscarTransacoesMes(uid, ano, mes) {
    const prefix = `${ano}-${String(mes).padStart(2, '0')}`;
    const snap = await db.collection('usuarios').doc(uid).collection('transacoes')
        .where('dataReferencia', '>=', `${prefix}-01`)
        .where('dataReferencia', '<=', `${prefix}-31`)
        .get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function buscarTodasTransacoesMes(uid, ano, mes) {
    const transacoes = await buscarTransacoesMes(uid, ano, mes);
    const receitas = transacoes.filter(t => t.tipo === 'receita');
    const despesas = transacoes.filter(t => t.tipo === 'despesa');
    const totalReceitas = receitas.reduce((s, t) => s + (t.valor || 0), 0);
    const totalDespesas = despesas.reduce((s, t) => s + (t.valor || 0), 0);
    return { transacoes, receitas, despesas, totalReceitas, totalDespesas, saldo: totalReceitas - totalDespesas };
}

// ========== CRUD CARTÕES ==========

async function buscarCartoes(uid) {
    const snap = await db.collection('usuarios').doc(uid).collection('cartoes').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ========== CRUD CONTAS ==========

async function buscarContas(uid) {
    const snap = await db.collection('usuarios').doc(uid).collection('contas').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ========== CRUD METAS ==========

async function buscarMetas(uid) {
    const snap = await db.collection('usuarios').doc(uid).collection('metas').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function depositarMeta(uid, metaId, valor) {
    const ref = db.collection('usuarios').doc(uid).collection('metas').doc(metaId);
    await ref.update({ valorAtual: admin.firestore.FieldValue.increment(valor) });
}

// ========== CRUD DÍVIDAS ==========

async function buscarDividas(uid) {
    const snap = await db.collection('usuarios').doc(uid).collection('dividas').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ========== CRUD INVESTIMENTOS ==========

async function buscarInvestimentos(uid) {
    const snap = await db.collection('usuarios').doc(uid).collection('investimentos').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ========== CRUD LIMITES ==========

async function buscarLimites(uid) {
    const snap = await db.collection('usuarios').doc(uid).collection('limites').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ========== CRUD CATEGORIAS ==========

async function buscarCategorias(uid) {
    const snap = await db.collection('usuarios').doc(uid).collection('categorias').get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

module.exports = {
    db, admin,
    encontrarUsuarioPorWhatsApp, temPlanoWhatsApp,
    registrarTransacao, buscarTransacoesMes, buscarTodasTransacoesMes,
    buscarCartoes, buscarContas,
    buscarMetas, depositarMeta,
    buscarDividas, buscarInvestimentos,
    buscarLimites, buscarCategorias
};
