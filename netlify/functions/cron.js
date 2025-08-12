const { Telegraf } = require('telegraf');
const admin = require('firebase-admin');

// --- Repita a configuração inicial do Firebase aqui ---
const FIREBASE_CREDS_JSON_STR = process.env.FIREBASE_CREDS_JSON;
if (FIREBASE_CREDS_JSON_STR && !admin.apps.length) {
    const serviceAccount = JSON.parse(FIREBASE_CREDS_JSON_STR);
    admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();
const bot = new Telegraf(process.env.TELEGRAM_TOKEN);

// --- Copie a função postMessageCallback aqui, mas adaptada ---
async function postMessage(bot, docId) {
    // ... lógica para buscar o post no DB e enviar a mensagem ...
}


// O handler principal da função agendada
exports.handler = async () => {
    console.log("[Cron Job] Verificando posts para enviar...");
    const nowInSeconds = Math.floor(Date.now() / 1000);

    const snapshot = await db.collection('scheduled_posts')
        .where('is_active', '==', true)
        .get();

    if (snapshot.empty) {
        console.log("[Cron Job] Nenhum post ativo encontrado.");
        return { statusCode: 200 };
    }

    for (const doc of snapshot.docs) {
        const post = doc.data();
        const lastRun = post.last_run_timestamp || 0;
        const interval = post.interval_seconds;

        // Verifica se já passou o tempo do intervalo desde a última execução
        if (nowInSeconds - lastRun >= interval) {
            console.log(`[Cron Job] Enviando post do agendamento ${doc.id}`);
            await postMessage(bot, doc.id); // Adapte a função postMessageCallback para este formato
            // Atualiza o timestamp da última execução
            await db.collection('scheduled_posts').doc(doc.id).update({
                last_run_timestamp: nowInSeconds
            });
        }
    }

    console.log("[Cron Job] Verificação concluída.");
    return { statusCode: 200 };
};