const { Telegraf } = require('telegraf');
const admin = require('firebase-admin');

// =================================================================================
// SEÇÃO DE CONFIGURAÇÃO INICIAL
// =================================================================================

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const FIREBASE_CREDS_JSON_STR = process.env.FIREBASE_CREDS_JSON;

// Inicializa o Firebase apenas uma vez
if (FIREBASE_CREDS_JSON_STR && !admin.apps.length) {
    try {
        const serviceAccount = JSON.parse(FIREBASE_CREDS_JSON_STR);
        admin.initializeApp({
            credential: admin.credential.cert(serviceAccount)
        });
        console.log("[Cron Job] Firebase inicializado com sucesso.");
    } catch (e) {
        console.error("[Cron Job] ERRO NA INICIALIZAÇÃO DO FIREBASE:", e);
    }
}
const db = admin.firestore();
const bot = new Telegraf(TELEGRAM_TOKEN);

// =================================================================================
// SEÇÃO DE LÓGICA DE POSTAGEM
// =================================================================================

async function sendPost(docId, scheduleData) {
    const { content_items, current_index = 0, chat_id } = scheduleData;

    if (!content_items || content_items.length === 0) {
        console.warn(`[Cron Job] Agendamento ${docId} não possui conteúdo. Será desativado.`);
        await db.collection('scheduled_posts').doc(docId).update({ is_active: false });
        return;
    }

    const contentToPost = content_items[current_index];

    try {
        const { type, data, caption } = contentToPost;
        const options = { caption: caption, parse_mode: 'HTML' };

        if (type === 'text') await bot.telegram.sendMessage(chat_id, data, { parse_mode: 'HTML' });
        else if (type === 'photo') await bot.telegram.sendPhoto(chat_id, data, options);
        else if (type === 'video') await bot.telegram.sendVideo(chat_id, data, options);
        else if (type === 'sticker') await bot.telegram.sendSticker(chat_id, data);

        console.log(`[Cron Job] SUCESSO: Conteúdo do agendamento ${docId} (índice ${current_index}) enviado para o chat ${chat_id}`);

        // Calcula o próximo índice para a rotação
        const nextIndex = (current_index + 1) % content_items.length;
        
        // Retorna o próximo índice para ser salvo no banco de dados
        return nextIndex;

    } catch (error) {
        console.error(`[Cron Job] ERRO ao enviar postagem do agendamento ${docId}:`, error.message);
        if (error.response && error.response.error_code === 403) {
            console.log(`[Cron Job] Bot foi proibido no chat ${chat_id}. Desativando agendamento.`);
            await db.collection('scheduled_posts').doc(docId).update({ is_active: false });
        }
        return null; // Retorna null em caso de erro
    }
}

// =================================================================================
// SEÇÃO DO HANDLER PRINCIPAL DO NETLIFY (FUNÇÃO AGENDADA)
// =================================================================================

exports.handler = async () => {
    console.log("[Cron Job] Verificando posts para enviar...");
    const nowInSeconds = Math.floor(Date.now() / 1000);

    const snapshot = await db.collection('scheduled_posts')
        .where('is_active', '==', true)
        .get();

    if (snapshot.empty) {
        console.log("[Cron Job] Nenhum post ativo encontrado.");
        return { statusCode: 200, body: "Nenhum post ativo." };
    }

    // Processa cada agendamento ativo
    for (const doc of snapshot.docs) {
        const post = doc.data();
        // Usa um timestamp para garantir que não envie posts rápido demais
        const lastRun = post.last_run_timestamp || 0;
        const interval = post.interval_seconds;

        // Verifica se já passou o tempo do intervalo desde a última execução
        if (interval && (nowInSeconds - lastRun >= interval)) {
            
            const nextIndex = await sendPost(doc.id, post);

            // Se o envio foi bem-sucedido (nextIndex não é null)
            if (nextIndex !== null) {
                // Atualiza o timestamp e o índice no Firestore
                await db.collection('scheduled_posts').doc(doc.id).update({
                    last_run_timestamp: nowInSeconds,
                    current_index: nextIndex
                });
            }
        }
    }

    console.log("[Cron Job] Verificação concluída.");
    return { statusCode: 200, body: "Verificação concluída." };
};
